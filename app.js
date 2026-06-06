const WEEKDAYS = ['DOMINGO', 'SEGUNDA-FEIRA', 'TERCA-FEIRA', 'QUARTA-FEIRA', 'QUINTA-FEIRA', 'SEXTA-FEIRA', 'SABADO'];
const MONTHS = ['JANEIRO', 'FEVEREIRO', 'MARCO', 'ABRIL', 'MAIO', 'JUNHO', 'JULHO', 'AGOSTO', 'SETEMBRO', 'OUTUBRO', 'NOVEMBRO', 'DEZEMBRO'];
const DEFAULT_COLORS = ['#ef4444', '#2563eb', '#16a34a', '#c084fc', '#f59e0b', '#0891b2', '#db2777', '#475569'];
const SATURDAY_TIMES = ['09:00', '09:30', '10:00', '10:30', '11:00', '11:30', '12:00', '12:30'];
const FRIDAY_TIMES = ['14:00', '14:30', '15:00', '15:30', '16:00', '16:30', '17:00', '17:30'];
const WEEKDAY_TIMES = [
  '08:00', '08:30', '09:00', '09:30', '10:00', '10:30',
  '11:00', '11:30', '12:00', '12:30', '13:00', '13:30',
  '14:00', '14:30', '15:00', '15:30', '16:00', '16:30',
  '17:00', '17:30', '18:00',
];

const DB = {
  client: supabaseClient,
  connected: Boolean(supabaseClient),
  user: null,
  profile: null,
  stores: [],
  clients: [],
  appointments: [],
  lastSync: null,
  timer: null,
  realtimeChannel: null,
  realtimeDebounce: null,
  realtimeStatus: 'offline',
  refreshInFlight: null,
  authSubscription: null,

  async init() {
    if (!this.client) return false;
    const { data } = await this.client.auth.getSession();
    if (!data.session) return false;
    return this.loadUser();
  },

  async loadUser() {
    const { data: userData, error: userError } = await this.client.auth.getUser();
    if (userError || !userData.user) return false;
    this.user = userData.user;

    let profile = await this.getProfile();
    if (!profile) {
      await this.bootstrapAdminProfile();
      profile = await this.getProfile();
    }

    if (!profile) {
      await this.signOut();
      throw new Error('Conta sem perfil. Peça para o admin recriar esta loja.');
    }

    this.profile = profile;
    await this.refresh();
    return true;
  },

  async getProfile() {
    const { data, error } = await this.client
      .from('profiles')
      .select('*, stores(*)')
      .eq('id', this.user.id)
      .maybeSingle();
    if (error) throw error;
    return data;
  },

  async bootstrapAdminProfile() {
    const name = this.user.user_metadata?.name || this.user.user_metadata?.nick || 'Administrador';
    await this.client
      .from('profiles')
      .insert({ id: this.user.id, role: 'admin', full_name: name });
  },

  async signIn(nick, password) {
    const email = nickToAuthEmail(nick);
    const { error } = await this.client.auth.signInWithPassword({ email, password });
    if (error) throw error;
    return this.loadUser();
  },

  async signUpAdmin(nick, password, name) {
    const cleanNick = normalizeNick(nick);
    const email = nickToAuthEmail(cleanNick);
    const { data, error } = await this.client.auth.signUp({
      email,
      password,
      options: { data: { name, nick: cleanNick } },
    });
    if (error) throw error;
    if (!data.session) return { needsConfirmation: true };
    await this.loadUser();
    return { needsConfirmation: false };
  },

  async signOut() {
    this.stopSync();
    this.user = null;
    this.profile = null;
    this.stores = [];
    this.clients = [];
    this.appointments = [];
    if (this.client) await this.client.auth.signOut();
  },

  async refresh() {
    const [profile, storesRes, appointmentsRes, clientsRes] = await Promise.all([
      this.user ? this.getProfile() : Promise.resolve(null),
      this.client.from('stores').select('*').order('name', { ascending: true }),
      this.client.from('appointments').select('*').order('date', { ascending: true }).order('time', { ascending: true }),
      this.client.from('clients').select('*').order('name', { ascending: true }),
    ]);

    if (storesRes.error) throw storesRes.error;
    if (appointmentsRes.error) throw appointmentsRes.error;
    if (clientsRes.error) throw clientsRes.error;

    if (profile) this.profile = profile;
    this.stores = storesRes.data || [];
    this.appointments = appointmentsRes.data || [];
    this.clients = clientsRes.data || [];
    this.lastSync = new Date();
    return true;
  },

  async startSync() {
    this.stopSync();
    if (!this.client) return;

    this.realtimeStatus = 'connecting';
    this.connected = true;
    App.updateConnStatus?.();

    const { data } = await this.client.auth.getSession();
    if (data.session?.access_token) {
      this.client.realtime.setAuth(data.session.access_token);
    }

    const { data: authData } = this.client.auth.onAuthStateChange((_event, session) => {
      if (session?.access_token) this.client.realtime.setAuth(session.access_token);
    });
    this.authSubscription = authData.subscription;

    const tables = ['stores', 'profiles', 'clients', 'appointments'];
    let channel = this.client.channel(`agenda-realtime-${this.user?.id || Date.now()}`);
    tables.forEach(table => {
      channel = channel.on(
        'postgres_changes',
        { event: '*', schema: 'public', table },
        () => this.queueRealtimeRefresh()
      );
    });

    this.realtimeChannel = channel.subscribe((status, err) => {
      if (status === 'SUBSCRIBED') {
        this.realtimeStatus = 'online';
        this.connected = true;
        App.updateConnStatus?.();
        return;
      }

      if (['CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED'].includes(status)) {
        this.realtimeStatus = 'offline';
        this.connected = false;
        App.updateConnStatus?.();
        if (err) App.toast(`Realtime: ${err.message || status}`, 'error');
      }
    });
  },

  stopSync() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.realtimeDebounce) clearTimeout(this.realtimeDebounce);
    this.realtimeDebounce = null;
    if (this.realtimeChannel) {
      this.client?.removeChannel(this.realtimeChannel);
      this.realtimeChannel = null;
    }
    this.authSubscription?.unsubscribe();
    this.authSubscription = null;
    this.realtimeStatus = 'offline';
  },

  queueRealtimeRefresh() {
    if (this.realtimeDebounce) clearTimeout(this.realtimeDebounce);
    this.realtimeDebounce = setTimeout(async () => {
      try {
        if (this.refreshInFlight) await this.refreshInFlight;
        this.refreshInFlight = this.refresh();
        await this.refreshInFlight;
        this.refreshInFlight = null;
        App.updateAccountBadge();
        App.render();
      } catch (err) {
        this.refreshInFlight = null;
        App.toast(err.message, 'error');
      }
    }, 120);
  },

  get appointmentsToday() {
    return this.appointments.filter(a => a.date === App.fmtDate(App.selDate));
  },

  getStore(id) {
    return this.stores.find(store => store.id === id);
  },

  getClient(id) {
    return this.clients.find(client => client.id === id);
  },

  canManageStore(storeId) {
    return this.profile?.role === 'admin' || this.profile?.store_id === storeId;
  },

  async createStore(payload) {
    if (this.profile?.role !== 'admin') {
      throw new Error('Apenas administradores podem criar lojas');
    }

    const nick = normalizeNick(payload.nick);
    const authEmail = nickToAuthEmail(nick);

    if (!payload.name?.trim() || nick.length < 3 || String(payload.password || '').length < 6) {
      throw new Error('Informe nome, nick com pelo menos 3 caracteres e senha com pelo menos 6 caracteres');
    }

    if (this.stores.some(store => store.login_nick === nick || store.auth_email === authEmail)) {
      throw new Error('Este nick ja esta em uso');
    }

    const authClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
    });

    const { data: authData, error: authError } = await authClient.auth.signUp({
      email: authEmail,
      password: payload.password,
      options: { data: { name: payload.name.trim(), nick } },
    });

    if (authError) throw authError;
    if (!authData.user?.id) {
      throw new Error('Nao foi possivel criar o login da loja. Confira se o cadastro de usuarios esta habilitado no Supabase.');
    }

    const { data: store, error: storeError } = await this.client
      .from('stores')
      .insert({
        name: payload.name.trim(),
        login_nick: nick,
        auth_email: authEmail,
        color: payload.color || '#2563eb',
        created_by: this.user.id,
      })
      .select()
      .single();

    if (storeError) throw storeError;

    const { error: profileError } = await this.client
      .from('profiles')
      .insert({
        id: authData.user.id,
        role: 'store',
        store_id: store.id,
        full_name: payload.name.trim(),
      });

    if (profileError) {
      await this.client.from('stores').delete().eq('id', store.id);
      throw profileError;
    }

    await this.refresh();
    return store;
  },

  async updateStore(storeId, payload) {
    if (this.profile?.role !== 'admin') {
      throw new Error('Apenas administradores podem editar lojas');
    }

    const { data, error } = await this.client.rpc('admin_update_store', {
      p_store_id: storeId,
      p_name: payload.name,
      p_login_nick: payload.nick,
      p_password: payload.password || null,
      p_color: payload.color,
    });

    if (error) throw error;
    await this.refresh();
    return data;
  },

  async saveClient(payload) {
    const current = payload.id ? this.getClient(payload.id) : null;
    const clean = {
      store_id: payload.store_id,
      name: payload.name.trim(),
      phone: onlyDigits(payload.phone),
      email: payload.email === undefined ? current?.email || null : payload.email?.trim() || null,
      notes: payload.notes === undefined ? current?.notes || null : payload.notes?.trim() || null,
      created_by: this.user.id,
    };

    if (payload.id) {
      const { data, error } = await this.client
        .from('clients')
        .update(clean)
        .eq('id', payload.id)
        .select()
        .single();
      if (error) throw error;
      await this.refresh();
      return data;
    }

    const existing = this.clients.find(c => c.store_id === clean.store_id && c.phone === clean.phone);
    if (existing) {
      const { data, error } = await this.client
        .from('clients')
        .update(clean)
        .eq('id', existing.id)
        .select()
        .single();
      if (error) throw error;
      await this.refresh();
      return data;
    }

    const { data, error } = await this.client
      .from('clients')
      .insert(clean)
      .select()
      .single();
    if (error) throw error;
    await this.refresh();
    return data;
  },

  async saveAppointment(payload) {
    const client = await this.saveClient({
      id: payload.client_id,
      store_id: payload.store_id,
      name: payload.client_name,
      phone: payload.client_phone,
      notes: payload.client_notes,
    });

    const clean = {
      store_id: payload.store_id,
      client_id: client.id,
      client_name: client.name,
      client_phone: client.phone,
      date: payload.date,
      time: normalizeTime(payload.time),
      notes: payload.notes?.trim() || null,
      status: payload.status || 'scheduled',
      created_by: this.user.id,
    };

    if (payload.id) {
      const { data, error } = await this.client
        .from('appointments')
        .update(clean)
        .eq('id', payload.id)
        .select()
        .single();
      if (error) throw error;
      await this.refresh();
      return data;
    }

    const { data, error } = await this.client
      .from('appointments')
      .insert(clean)
      .select()
      .single();
    if (error) throw error;
    await this.refresh();
    return data;
  },

  async removeAppointment(id) {
    const { error } = await this.client.from('appointments').delete().eq('id', id);
    if (error) throw error;
    await this.refresh();
  },
};

const App = {
  authMode: 'login',
  activeView: 'agenda',
  scheduleMode: 'grid',
  clientsScope: 'own',
  today: new Date(),
  selDate: new Date(),
  calDate: new Date(),

  async boot() {
    this.bindAuth();
    this.bindGlobal();

    if (!hasSupabaseConfig()) {
      this.showLogin();
      document.getElementById('setup-warning').classList.remove('hidden');
      return;
    }

    try {
      const logged = await DB.init();
      if (logged) this.showApp();
      else this.showLogin();
    } catch (err) {
      this.showLogin();
      this.toast(err.message, 'error');
    }
  },

  showLogin() {
    document.getElementById('loading').classList.add('hidden');
    document.getElementById('login').classList.remove('hidden');
    document.getElementById('app').classList.add('hidden');
  },

  async showApp() {
    document.getElementById('loading').classList.add('hidden');
    document.getElementById('login').classList.add('hidden');
    document.getElementById('app').classList.remove('hidden');

    this.updateAccountBadge();
    document.querySelectorAll('.admin-only').forEach(el => {
      el.classList.toggle('hidden', DB.profile.role !== 'admin');
    });
    this.bindAppEvents();
    DB.startSync().catch(err => {
      DB.connected = false;
      DB.realtimeStatus = 'offline';
      this.updateConnStatus();
      this.toast(`Realtime: ${err.message}`, 'error');
    });
    this.render();
  },

  bindAuth() {
    this.bindPasswordToggles(document);

    document.querySelectorAll('.auth-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        this.authMode = btn.dataset.mode;
        document.querySelectorAll('.auth-tab').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        document.getElementById('auth-name-wrap').classList.toggle('hidden', this.authMode !== 'signup');
        document.getElementById('auth-submit').innerHTML = this.authMode === 'signup'
          ? '<i class="fas fa-user-plus"></i> Criar admin'
          : '<i class="fas fa-right-to-bracket"></i> Entrar';
      });
    });

    document.getElementById('login-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      if (!hasSupabaseConfig()) {
        this.toast('Configure as chaves do Supabase primeiro', 'error');
        return;
      }

      const nick = document.getElementById('auth-nick').value.trim();
      const password = document.getElementById('auth-password').value;
      const name = document.getElementById('auth-name').value.trim();
      const button = document.getElementById('auth-submit');
      button.disabled = true;
      button.classList.add('loading-btn');

      try {
        if (normalizeNick(nick).length < 3) {
          throw new Error('Use um nick com pelo menos 3 caracteres');
        }
        if (this.authMode === 'signup') {
          const result = await DB.signUpAdmin(nick, password, name || nick);
          if (result.needsConfirmation) {
            this.toast('Conta criada. Desative confirmacao de email no Supabase ou confirme pelo painel.', 'success');
            this.authMode = 'login';
            document.querySelector('[data-mode="login"]').click();
            return;
          }
        } else {
          await DB.signIn(nick, password);
        }
        this.showApp();
        this.toast('Bem-vindo!', 'success');
      } catch (err) {
        this.toast(err.message, 'error');
      } finally {
        button.disabled = false;
        button.classList.remove('loading-btn');
      }
    });
  },

  bindGlobal() {
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape') this.closeModal();
    });
  },

  bindAppEvents() {
    if (this._appEventsBound) return;
    this._appEventsBound = true;

    document.getElementById('cal-prev').onclick = () => {
      this.calDate.setMonth(this.calDate.getMonth() - 1);
      this.renderCalendar();
    };
    document.getElementById('cal-next').onclick = () => {
      this.calDate.setMonth(this.calDate.getMonth() + 1);
      this.renderCalendar();
    };
    document.getElementById('btn-today').onclick = () => {
      this.selDate = new Date();
      this.calDate = new Date();
      this.render();
    };
    document.getElementById('btn-refresh').onclick = async () => {
      try {
        await DB.refresh();
        this.render();
        this.toast('Atualizado', 'success');
      } catch (err) {
        this.toast(err.message, 'error');
      }
    };
    document.getElementById('btn-logout').onclick = () => this.logout();
    document.getElementById('btn-menu').onclick = () => document.getElementById('sidebar').classList.toggle('open');
    document.getElementById('btn-theme').onclick = () => this.toggleTheme();

    document.querySelectorAll('.nav-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.activeView = btn.dataset.view;
        document.getElementById('sidebar').classList.remove('open');
        this.render();
      });
    });

    document.querySelectorAll('.view-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        this.activeView = 'agenda';
        document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
        document.querySelector('.nav-btn[data-view="agenda"]')?.classList.add('active');
        document.querySelectorAll('.view-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.scheduleMode = btn.dataset.mode;
        this.render();
      });
    });
  },

  async logout() {
    await DB.signOut();
    this._appEventsBound = false;
    this.showLogin();
  },

  render() {
    this.updateDateHeader();
    this.renderCalendar();
    this.updateConnStatus();

    if (this.activeView === 'clients') this.renderClients();
    else if (this.activeView === 'admin') this.renderAdmin();
    else this.renderAgenda();
  },

  updateAccountBadge() {
    const store = DB.profile.stores;
    const title = DB.profile.role === 'admin' ? 'Administrador' : store?.name || 'Loja';
    const role = DB.profile.role === 'admin' ? 'acesso total' : 'loja';
    document.getElementById('badge-title').textContent = title;
    document.getElementById('badge-role').textContent = role;
    document.querySelector('#store-badge .dot').style.background = store?.color || '#111827';
  },

  updateDateHeader() {
    const d = this.selDate;
    document.getElementById('h-day').textContent = String(d.getDate()).padStart(2, '0');
    document.getElementById('h-weekday').textContent = WEEKDAYS[d.getDay()];
    document.getElementById('h-monthyear').textContent = `${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
  },

  updateConnStatus() {
    const el = document.getElementById('conn-status');
    const online = DB.connected && DB.realtimeStatus !== 'offline';
    const label = DB.realtimeStatus === 'online'
      ? 'Realtime'
      : DB.realtimeStatus === 'connecting'
        ? 'Conectando'
        : 'Offline';
    el.className = `conn-status ${online ? 'online' : 'offline'}`;
    el.innerHTML = `<span class="pulse"></span>${label}`;
  },

  renderCalendar() {
    const y = this.calDate.getFullYear();
    const m = this.calDate.getMonth();
    const first = new Date(y, m, 1).getDay();
    const days = new Date(y, m + 1, 0).getDate();
    const prevDays = new Date(y, m, 0).getDate();
    const currentPrefix = `${y}-${String(m + 1).padStart(2, '0')}`;
    const daysWithApt = new Set(
      DB.appointments
        .filter(a => a.date?.startsWith(currentPrefix))
        .map(a => Number(a.date.split('-')[2]))
    );

    document.getElementById('cal-title').textContent = `${MONTHS[m]} ${y}`;
    let html = '';

    for (let i = first - 1; i >= 0; i--) html += `<div class="cal-day other">${prevDays - i}</div>`;
    for (let day = 1; day <= days; day++) {
      const isToday = sameDate(this.today, new Date(y, m, day));
      const isSelected = sameDate(this.selDate, new Date(y, m, day));
      const classes = ['cal-day'];
      if (isToday) classes.push('today');
      if (isSelected && !isToday) classes.push('selected');
      if (daysWithApt.has(day)) classes.push('has-apt');
      html += `<button class="${classes.join(' ')}" data-day="${day}">${day}</button>`;
    }

    const total = first + days;
    const fill = total <= 35 ? 35 - total : 42 - total;
    for (let day = 1; day <= fill; day++) html += `<div class="cal-day other">${day}</div>`;

    const container = document.getElementById('cal-days');
    container.innerHTML = html;
    container.querySelectorAll('[data-day]').forEach(day => {
      day.addEventListener('click', () => {
        this.selDate = new Date(y, m, Number(day.dataset.day));
        this.render();
      });
    });
  },

  renderAgenda() {
    const content = document.getElementById('content');
    const stores = DB.stores;
    const dateStr = this.fmtDate(this.selDate);

    if (!stores.length) {
      content.innerHTML = this.emptyState('fa-store', 'Nenhuma loja cadastrada', DB.profile.role === 'admin'
        ? 'Crie a primeira loja na tela Admin.'
        : 'Peça para o administrador vincular sua conta a uma loja.');
      return;
    }

    if (isSunday(this.selDate)) {
      content.innerHTML = this.emptyState('fa-moon', 'Fechado aos domingos', 'Escolha outro dia no calendario.');
      return;
    }

    if (this.scheduleMode === 'simplified') {
      this.renderSimplified();
      return;
    }

    const times = getTimesForDate(this.selDate);
    const appointments = DB.appointments.filter(a => a.date === dateStr && a.status !== 'cancelled');
    const gridCols = `76px repeat(${stores.length}, minmax(150px, 1fr))`;

    let html = `<div class="schedule-grid" style="grid-template-columns:${gridCols}">`;
    html += '<div class="grid-corner">Hora</div>';
    stores.forEach(store => {
      html += `<div class="grid-store-header"><span class="dot" style="background:${store.color}"></span>${esc(store.name)}</div>`;
    });

    times.forEach(time => {
      html += `<div class="grid-time">${time}</div>`;
      stores.forEach(store => {
        const apt = appointments.find(a => a.store_id === store.id && normalizeTime(a.time) === time);
        const canAdd = DB.canManageStore(store.id) && !apt;
        if (apt) {
          html += `<div class="grid-cell filled" data-apt-id="${apt.id}">
            <div class="apt-card" style="--store:${store.color}; border-color:${store.color}">
              <div class="apt-name">${esc(apt.client_name)}</div>
              <div class="apt-phone">${this.fmtPhone(apt.client_phone)}</div>
            </div>
          </div>`;
        } else {
          html += `<div class="grid-cell ${canAdd ? 'can-add' : ''}" data-store="${store.id}" data-time="${time}">
            ${canAdd ? '<span class="add-icon">+</span>' : ''}
          </div>`;
        }
      });
    });
    html += '</div>';
    content.innerHTML = html;

    content.querySelectorAll('[data-apt-id]').forEach(el => {
      el.addEventListener('click', () => this.openAppointmentDetail(el.dataset.aptId));
    });
    content.querySelectorAll('.grid-cell.can-add').forEach(cell => {
      cell.addEventListener('click', () => this.openAppointmentModal({
        store_id: cell.dataset.store,
        time: cell.dataset.time,
      }));
    });
  },

  renderSimplified() {
    const dateStr = this.fmtDate(this.selDate);
    const times = getTimesForDate(this.selDate);
    const appointments = DB.appointments.filter(a => a.date === dateStr && a.status !== 'cancelled');
    const sections = [
      { label: 'Manha', icon: 'fa-sun', times: times.filter(time => parseMinutes(time) < 13 * 60) },
      { label: 'Tarde', icon: 'fa-cloud-sun', times: times.filter(time => parseMinutes(time) >= 13 * 60) },
    ].filter(section => section.times.length);

    let html = '<div class="simplified-view">';

    sections.forEach(section => {
      html += `<section class="simp-section">
        <div class="simp-tab"><i class="fas ${section.icon}"></i><span>${section.label}</span></div>
        <div class="simp-table-wrap">
          <table class="simp-table">
            <thead><tr>${section.times.map(time => `<th>${time}</th>`).join('')}</tr></thead>
            <tbody><tr>`;

      section.times.forEach(time => {
        const atTime = appointments.filter(apt => normalizeTime(apt.time) === time);
        const canAdd = DB.profile.role === 'admin' || DB.profile.store_id;
        html += `<td class="${atTime.length ? 'filled' : 'empty'}" data-time="${time}">
          ${atTime.length ? atTime.map(apt => {
            const store = DB.getStore(apt.store_id);
            return `<button class="simp-apt" data-apt-id="${apt.id}" style="--store:${store?.color || '#64748b'}">
              <span class="simp-store"><span class="dot" style="background:${store?.color || '#64748b'}"></span>${esc(store?.name || 'Loja')}</span>
              <strong>${esc(apt.client_name)}</strong>
            </button>`;
          }).join('') : (canAdd ? '<button class="simp-add" type="button"><i class="fas fa-plus"></i></button>' : '')}
        </td>`;
      });

      html += `</tr></tbody></table></div></section>`;
    });

    html += '</div>';
    document.getElementById('content').innerHTML = html;
    document.querySelectorAll('.simp-apt').forEach(card => {
      card.addEventListener('click', () => this.openAppointmentDetail(card.dataset.aptId));
    });
    document.querySelectorAll('.simp-table td.empty').forEach(cell => {
      cell.addEventListener('click', () => this.openAppointmentModal({
        store_id: DB.profile.role === 'store' ? DB.profile.store_id : DB.stores[0]?.id,
        time: cell.dataset.time,
      }));
    });
  },

  renderClients() {
    const canPickStore = DB.profile.role === 'admin';
    const canToggleAll = DB.profile.role === 'store';
    const showingAll = DB.profile.role === 'admin' || this.clientsScope === 'all';
    const clients = showingAll
      ? [...DB.clients]
      : DB.clients.filter(client => client.store_id === DB.profile.store_id);

    const html = `<div class="toolbar">
      <div>
        <h2>Clientes</h2>
        <p>${showingAll ? 'Todos os clientes com etiquetas por loja.' : 'Clientes da loja logada.'}</p>
      </div>
      <div class="toolbar-actions">
        ${canToggleAll ? `<button class="btn btn-secondary" id="toggle-clients"><i class="fas fa-tags"></i> ${showingAll ? 'Minha loja' : 'Todos'}</button>` : ''}
        <button class="btn btn-primary" id="new-client"><i class="fas fa-user-plus"></i> Cliente</button>
      </div>
    </div>
    ${clients.length ? `<div class="client-grid">
      ${clients.map(client => {
        const store = DB.getStore(client.store_id);
        const canEdit = DB.canManageStore(client.store_id);
        return `<button class="client-card" data-client-id="${client.id}" ${canEdit ? '' : 'data-readonly="1"'} style="--store:${store?.color || '#64748b'}">
          <span class="client-store"><span class="dot" style="background:${store?.color || '#64748b'}"></span>${esc(store?.name || 'Loja')}</span>
          <strong>${esc(client.name)}</strong>
          <span>${this.fmtPhone(client.phone)}</span>
          ${client.email ? `<small>${esc(client.email)}</small>` : ''}
        </button>`;
      }).join('')}
    </div>` : this.emptyState('fa-user-group', 'Nenhum cliente ainda', 'Cadastre clientes avulsos ou crie um agendamento.')}`;

    document.getElementById('content').innerHTML = html;
    document.getElementById('toggle-clients')?.addEventListener('click', () => {
      this.clientsScope = this.clientsScope === 'all' ? 'own' : 'all';
      this.renderClients();
    });
    document.getElementById('new-client').onclick = () => this.openClientModal();
    document.querySelectorAll('[data-client-id]').forEach(row => {
      row.addEventListener('click', () => {
        const client = DB.getClient(row.dataset.clientId);
        if (!DB.canManageStore(client.store_id)) {
          this.toast('Cliente de outra loja: somente visualizacao', 'info');
          return;
        }
        this.openClientModal(client);
      });
    });
  },

  renderAdmin() {
    if (DB.profile.role !== 'admin') {
      this.activeView = 'agenda';
      this.renderAgenda();
      return;
    }

    const today = this.fmtDate(new Date());
    const todayCount = DB.appointments.filter(a => a.date === today && a.status !== 'cancelled').length;

    const html = `<div class="toolbar">
      <div>
        <h2>Admin</h2>
        <p>Crie lojas, logins e acompanhe o movimento geral.</p>
      </div>
      <button class="btn btn-primary" id="open-store-form"><i class="fas fa-store"></i> Nova loja</button>
    </div>
    <div class="stat-grid">
      <div class="stat"><span>${DB.stores.length}</span><small>Lojas ativas</small></div>
      <div class="stat"><span>${DB.clients.length}</span><small>Clientes</small></div>
      <div class="stat"><span>${todayCount}</span><small>Hoje</small></div>
      <div class="stat"><span>${DB.appointments.length}</span><small>Total agenda</small></div>
    </div>
    <div class="panel">
      <div class="panel-head">
        <h3>Lojas</h3>
        <span>${DB.stores.length} cadastro(s)</span>
      </div>
      ${DB.stores.length ? `<div class="store-list">
        ${DB.stores.map(store => `<button class="store-row" data-store-id="${store.id}">
          <span class="store-color" style="background:${store.color}"></span>
          <div>
            <strong>${esc(store.name)}</strong>
            <small>${esc(store.login_nick)} - clique para editar</small>
          </div>
          <i class="fas fa-chevron-right"></i>
        </button>`).join('')}
      </div>` : this.emptyState('fa-store', 'Nenhuma loja cadastrada', 'Use o botao Nova loja para criar login e agenda da loja.')}
    </div>`;

    document.getElementById('content').innerHTML = html;
    document.getElementById('open-store-form').onclick = () => this.openStoreModal();
    document.querySelectorAll('[data-store-id]').forEach(row => {
      row.addEventListener('click', () => this.openStoreModal(DB.getStore(row.dataset.storeId)));
    });
  },

  openAppointmentModal(defaults = {}) {
    const allowedStores = DB.profile.role === 'admin'
      ? DB.stores
      : DB.stores.filter(store => store.id === DB.profile.store_id);

    if (!allowedStores.length) {
      this.toast('Nenhuma loja disponivel para agendar', 'error');
      return;
    }

    const selectedStoreId = defaults.store_id || allowedStores[0].id;
    const store = DB.getStore(selectedStoreId) || allowedStores[0];
    const dateValue = isSunday(this.selDate) ? this.fmtDate(nextOpenDate(this.selDate)) : this.fmtDate(this.selDate);
    const initialTimes = getTimesForDate(parseLocalDate(dateValue));
    const time = defaults.time || initialTimes[0] || '08:00';

    this.openModal(`<div class="modal-head">
      <h3>Novo agendamento</h3>
      <button class="modal-close">&times;</button>
    </div>
    <form class="modal-body form-stack" id="appointment-form">
      <label>Loja
        <select id="apt-store" ${DB.profile.role === 'store' ? 'disabled' : ''}>
          ${allowedStores.map(s => `<option value="${s.id}" ${s.id === store.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}
        </select>
      </label>
      <div class="field-row">
        <label>Data
          <input type="date" id="apt-date" value="${dateValue}">
        </label>
        <label>Horario
          <select id="apt-time">${initialTimes.map(t => `<option value="${t}" ${t === time ? 'selected' : ''}>${t}</option>`).join('')}</select>
        </label>
      </div>
      <label>Cliente
        <input type="text" id="apt-client" list="clients-list" placeholder="Nome completo" required>
        <datalist id="clients-list">
          ${DB.clients.filter(c => c.store_id === store.id).map(c => `<option value="${esc(c.name)}" data-phone="${esc(c.phone)}"></option>`).join('')}
        </datalist>
      </label>
      <label>Telefone
        <input type="tel" id="apt-phone" placeholder="19912345678" required>
      </label>
      <label>Observacoes
        <textarea id="apt-notes" placeholder="Opcional"></textarea>
      </label>
      <div class="modal-foot">
        <button class="btn btn-secondary modal-close" type="button">Cancelar</button>
        <button class="btn btn-primary" type="submit">Agendar</button>
      </div>
    </form>`);

    document.getElementById('apt-store').onchange = event => {
      const selected = DB.getStore(event.target.value);
      document.getElementById('clients-list').innerHTML = DB.clients
        .filter(c => c.store_id === selected.id)
        .map(c => `<option value="${esc(c.name)}" data-phone="${esc(c.phone)}"></option>`)
        .join('');
    };

    document.getElementById('apt-date').onchange = event => {
      const date = parseLocalDate(event.target.value);
      const times = getTimesForDate(date);
      document.getElementById('apt-time').innerHTML = times.map(t => `<option value="${t}">${t}</option>`).join('');
      if (!times.length) this.toast('Fechado aos domingos', 'error');
    };

    document.getElementById('apt-client').onchange = event => {
      const currentStore = document.getElementById('apt-store').value;
      const client = DB.clients.find(c => c.store_id === currentStore && c.name === event.target.value);
      if (client) {
        document.getElementById('apt-phone').value = this.fmtPhone(client.phone);
      }
    };

    document.getElementById('appointment-form').onsubmit = async event => {
      event.preventDefault();
      const payload = this.readAppointmentForm();
      if (isSunday(parseLocalDate(payload.date))) {
        this.toast('Fechado aos domingos', 'error');
        return;
      }
      if (!getTimesForDate(parseLocalDate(payload.date)).includes(normalizeTime(payload.time))) {
        this.toast('Horario fora da grade do dia', 'error');
        return;
      }
      if (this.hasAppointmentConflict(payload)) {
        this.toast('Este horario ja esta ocupado nesta loja', 'error');
        return;
      }
      try {
        await DB.saveAppointment(payload);
        this.closeModal();
        this.selDate = parseLocalDate(payload.date);
        this.calDate = parseLocalDate(payload.date);
        this.render();
        this.toast('Agendamento criado', 'success');
      } catch (err) {
        this.toast(err.message, 'error');
      }
    };
  },

  openAppointmentDetail(id) {
    const apt = DB.appointments.find(row => row.id === id);
    if (!apt) return;
    const store = DB.getStore(apt.store_id);
    const canEdit = DB.canManageStore(apt.store_id);
    const times = getTimesForDate(parseLocalDate(apt.date));

    this.openModal(`<div class="modal-head">
      <h3>${canEdit ? 'Editar' : 'Visualizar'} agendamento</h3>
      <button class="modal-close">&times;</button>
    </div>
    <form class="modal-body form-stack" id="appointment-detail-form">
      <label>Loja
        <input type="text" value="${esc(store?.name || 'Loja')}" disabled>
      </label>
      <div class="field-row">
        <label>Data
          <input type="date" id="apt-date" value="${apt.date}" ${canEdit ? '' : 'disabled'}>
        </label>
        <label>Horario
          <select id="apt-time" ${canEdit ? '' : 'disabled'}>${times.map(t => `<option value="${t}" ${t === normalizeTime(apt.time) ? 'selected' : ''}>${t}</option>`).join('')}</select>
        </label>
      </div>
      <label>Cliente
        <input type="text" id="apt-client" value="${esc(apt.client_name)}" ${canEdit ? '' : 'disabled'}>
      </label>
      <label>Telefone
        <input type="tel" id="apt-phone" value="${this.fmtPhone(apt.client_phone)}" ${canEdit ? '' : 'disabled'}>
      </label>
      <label>Observacoes
        <textarea id="apt-notes" ${canEdit ? '' : 'disabled'}>${esc(apt.notes || '')}</textarea>
      </label>
      <div class="modal-foot appointment-actions">
        <button class="btn btn-whatsapp" type="button" id="whatsapp"><i class="fab fa-whatsapp"></i> WhatsApp</button>
        ${canEdit ? '<button class="btn btn-danger" type="button" id="delete-apt"><i class="fas fa-trash"></i> Excluir</button>' : ''}
        ${canEdit ? '<button class="btn btn-primary" type="submit">Salvar</button>' : ''}
      </div>
    </form>`);

    document.getElementById('whatsapp').onclick = () => {
      const phone = onlyDigits(document.getElementById('apt-phone').value);
      const name = document.getElementById('apt-client').value || 'cliente';
      const time = document.getElementById('apt-time').value;
      const date = document.getElementById('apt-date').value.split('-').reverse().join('/');
      if (phone) {
        const msg = encodeURIComponent(`Ola ${name}! Confirmamos seu agendamento para ${date} as ${time}.`);
        window.open(`https://wa.me/55${phone}?text=${msg}`, '_blank');
      }
    };

    document.getElementById('delete-apt')?.addEventListener('click', async () => {
      if (!confirm('Excluir este agendamento?')) return;
      try {
        await DB.removeAppointment(apt.id);
        this.closeModal();
        this.render();
        this.toast('Agendamento excluido', 'success');
      } catch (err) {
        this.toast(err.message, 'error');
      }
    });

    document.getElementById('appointment-detail-form').onsubmit = async event => {
      event.preventDefault();
      const payload = {
        id: apt.id,
        client_id: apt.client_id,
        store_id: apt.store_id,
        date: document.getElementById('apt-date').value,
        time: document.getElementById('apt-time').value,
        client_name: document.getElementById('apt-client').value.trim(),
        client_phone: document.getElementById('apt-phone').value,
        notes: document.getElementById('apt-notes').value,
        status: apt.status || 'scheduled',
      };
      if (this.hasAppointmentConflict(payload, apt.id)) {
        this.toast('Este horario ja esta ocupado nesta loja', 'error');
        return;
      }
      if (isSunday(parseLocalDate(payload.date))) {
        this.toast('Fechado aos domingos', 'error');
        return;
      }
      if (!getTimesForDate(parseLocalDate(payload.date)).includes(normalizeTime(payload.time))) {
        this.toast('Horario fora da grade do dia', 'error');
        return;
      }
      try {
        await DB.saveAppointment(payload);
        this.closeModal();
        this.render();
        this.toast('Agendamento atualizado', 'success');
      } catch (err) {
        this.toast(err.message, 'error');
      }
    };
  },

  openClientModal(client = null) {
    const stores = DB.profile.role === 'admin' ? DB.stores : DB.stores.filter(s => s.id === DB.profile.store_id);
    const selectedStoreId = client?.store_id || stores[0]?.id;

    this.openModal(`<div class="modal-head">
      <h3>${client ? 'Editar cliente' : 'Novo cliente'}</h3>
      <button class="modal-close">&times;</button>
    </div>
    <form class="modal-body form-stack" id="client-form">
      <label>Loja
        <select id="client-store" ${DB.profile.role === 'store' ? 'disabled' : ''}>
          ${stores.map(s => `<option value="${s.id}" ${s.id === selectedStoreId ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}
        </select>
      </label>
      <label>Nome
        <input type="text" id="client-name" value="${esc(client?.name || '')}" required>
      </label>
      <label>Telefone
        <input type="tel" id="client-phone" value="${this.fmtPhone(client?.phone || '')}" required>
      </label>
      <label>Observacoes
        <textarea id="client-notes">${esc(client?.notes || '')}</textarea>
      </label>
      <div class="modal-foot">
        <button class="btn btn-secondary modal-close" type="button">Cancelar</button>
        <button class="btn btn-primary" type="submit">Salvar</button>
      </div>
    </form>`);

    document.getElementById('client-form').onsubmit = async event => {
      event.preventDefault();
      try {
        await DB.saveClient({
          id: client?.id,
          store_id: document.getElementById('client-store').value,
          name: document.getElementById('client-name').value,
          phone: document.getElementById('client-phone').value,
          email: '',
          notes: document.getElementById('client-notes').value,
        });
        this.closeModal();
        this.render();
        this.toast('Cliente salvo', 'success');
      } catch (err) {
        this.toast(err.message, 'error');
      }
    };
  },

  openStoreModal(store = null) {
    const isEdit = Boolean(store);
    const nextColor = store?.color || DEFAULT_COLORS[DB.stores.length % DEFAULT_COLORS.length];
    this.openModal(`<div class="modal-head">
      <h3>${isEdit ? 'Editar loja' : 'Nova loja'}</h3>
      <button class="modal-close">&times;</button>
    </div>
    <form class="modal-body form-stack store-form" id="store-form">
      <div class="store-form-note">
        <i class="fas fa-calendar-day"></i>
        <span>Segunda a quinta das 08:00 as 18:00. Sexta das 14:00 as 17:30. Sabado das 09:00 as 13:00.</span>
      </div>
      <label>Nome da loja
        <input type="text" id="store-name" placeholder="Loja Centro" value="${esc(store?.name || '')}" required>
      </label>
      <label>Nick/login
        <input type="text" id="store-nick" placeholder="loja-centro" value="${esc(store?.login_nick || '')}" required>
      </label>
      <label>Senha
        <span class="password-row">
          <input type="password" id="store-password" minlength="6" placeholder="${isEdit ? 'Deixe em branco para manter' : 'Minimo 6 caracteres'}" ${isEdit ? '' : 'required'}>
          <button class="btn-eye" type="button" data-toggle-password="store-password" title="Mostrar senha"><i class="fas fa-eye"></i></button>
        </span>
      </label>
      <label>Cor da loja
        <input type="hidden" id="store-color" value="${nextColor}">
        <div class="color-swatches" id="store-color-swatches">
          ${DEFAULT_COLORS.map(color => `<button class="color-swatch ${color === nextColor ? 'active' : ''}" type="button" data-color="${color}" style="--swatch:${color}" title="${color}"></button>`).join('')}
        </div>
      </label>
      <div class="modal-foot store-actions">
        <button class="btn btn-secondary modal-close" type="button">Cancelar</button>
        <button class="btn btn-primary" type="submit">${isEdit ? 'Salvar loja' : 'Criar loja'}</button>
      </div>
    </form>`);

    document.querySelectorAll('#store-color-swatches .color-swatch').forEach(button => {
      button.addEventListener('click', () => {
        document.querySelectorAll('#store-color-swatches .color-swatch').forEach(item => item.classList.remove('active'));
        button.classList.add('active');
        document.getElementById('store-color').value = button.dataset.color;
      });
    });

    document.getElementById('store-form').onsubmit = async event => {
      event.preventDefault();
      try {
        const payload = {
          name: document.getElementById('store-name').value,
          nick: document.getElementById('store-nick').value,
          password: document.getElementById('store-password').value,
          color: document.getElementById('store-color').value,
        };
        if (isEdit) await DB.updateStore(store.id, payload);
        else await DB.createStore(payload);
        this.closeModal();
        this.render();
        this.toast(isEdit ? 'Loja atualizada' : 'Loja criada com login proprio', 'success');
      } catch (err) {
        this.toast(err.message, 'error');
      }
    };
  },

  bindPasswordToggles(scope) {
    scope.querySelectorAll('[data-toggle-password]').forEach(button => {
      if (button.dataset.bound === '1') return;
      button.dataset.bound = '1';
      button.addEventListener('click', () => {
        const input = document.getElementById(button.dataset.togglePassword);
        if (!input) return;
        const willShow = input.type === 'password';
        input.type = willShow ? 'text' : 'password';
        button.innerHTML = `<i class="fas fa-${willShow ? 'eye-slash' : 'eye'}"></i>`;
        button.title = willShow ? 'Ocultar senha' : 'Mostrar senha';
      });
    });
  },

  readAppointmentForm() {
    return {
      store_id: document.getElementById('apt-store').value,
      date: document.getElementById('apt-date').value,
      time: document.getElementById('apt-time').value,
      client_name: document.getElementById('apt-client').value.trim(),
      client_phone: document.getElementById('apt-phone').value,
      notes: document.getElementById('apt-notes').value,
    };
  },

  hasAppointmentConflict(payload, ignoreId = null) {
    return DB.appointments.some(apt => {
      return apt.id !== ignoreId
        && apt.store_id === payload.store_id
        && apt.date === payload.date
        && normalizeTime(apt.time) === normalizeTime(payload.time)
        && apt.status !== 'cancelled';
    });
  },

  openModal(html) {
    this.closeModal();
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.id = 'modal';
    overlay.innerHTML = `<div class="modal-box">${html}</div>`;
    document.body.appendChild(overlay);
    overlay.addEventListener('click', event => {
      if (event.target === overlay) this.closeModal();
    });
    overlay.querySelectorAll('.modal-close').forEach(btn => btn.addEventListener('click', () => this.closeModal()));
    this.bindPasswordToggles(overlay);
  },

  closeModal() {
    document.getElementById('modal')?.remove();
  },

  toggleTheme() {
    const html = document.documentElement;
    const isLight = html.getAttribute('data-theme') === 'light';
    if (isLight) {
      html.removeAttribute('data-theme');
      localStorage.setItem('otica_theme', 'dark');
      document.getElementById('btn-theme').innerHTML = '<i class="fas fa-sun"></i>';
    } else {
      html.setAttribute('data-theme', 'light');
      localStorage.removeItem('otica_theme');
      document.getElementById('btn-theme').innerHTML = '<i class="fas fa-moon"></i>';
    }
  },

  emptyState(icon, title, text) {
    return `<div class="empty-state"><i class="fas ${icon}"></i><h3>${title}</h3><p>${text}</p></div>`;
  },

  toast(message, type = 'info') {
    const wrap = document.getElementById('toasts');
    const el = document.createElement('div');
    const icon = type === 'success' ? 'check' : type === 'error' ? 'exclamation-triangle' : 'info-circle';
    el.className = `toast ${type}`;
    el.innerHTML = `<i class="fas fa-${icon}"></i>${esc(message)}`;
    wrap.appendChild(el);
    setTimeout(() => el.remove(), 3500);
  },

  fmtDate(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  },

  fmtDateDisplay(d) {
    return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
  },

  fmtPhone(phone) {
    const p = onlyDigits(phone);
    if (p.length === 11) return `(${p.slice(0, 2)}) ${p.slice(2, 7)}-${p.slice(7)}`;
    if (p.length === 10) return `(${p.slice(0, 2)}) ${p.slice(2, 6)}-${p.slice(6)}`;
    return phone || '';
  },
};

function esc(value) {
  const div = document.createElement('div');
  div.textContent = value ?? '';
  return div.innerHTML;
}

function onlyDigits(value) {
  return String(value || '').replace(/\D/g, '');
}

function normalizeNick(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
}

function nickToAuthEmail(nick) {
  return `${normalizeNick(nick)}@agenda.local`;
}

function normalizeTime(value) {
  return String(value || '').slice(0, 5);
}

function parseMinutes(value) {
  const [h, m] = normalizeTime(value).split(':').map(Number);
  return h * 60 + m;
}

function formatMinutes(total) {
  const h = Math.floor(total / 60);
  const m = total % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function timesForStore() {
  return getTimesForDate(App.selDate);
}

function getTimesForDate(date) {
  if (isFriday(date)) return FRIDAY_TIMES;
  if (isSaturday(date)) return SATURDAY_TIMES;
  if (isSunday(date)) return [];
  return WEEKDAY_TIMES;
}

function isFriday(date) {
  return date.getDay() === 5;
}

function isSaturday(date) {
  return date.getDay() === 6;
}

function isSunday(date) {
  return date.getDay() === 0;
}

function nextOpenDate(date) {
  const out = new Date(date);
  do {
    out.setDate(out.getDate() + 1);
  } while (isSunday(out));
  return out;
}

function sameDate(a, b) {
  return a.getFullYear() === b.getFullYear()
    && a.getMonth() === b.getMonth()
    && a.getDate() === b.getDate();
}

function parseLocalDate(value) {
  const [y, m, d] = value.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function labelStatus(value) {
  const labels = { scheduled: 'Agendado', done: 'Atendido', cancelled: 'Cancelado' };
  return labels[value] || value;
}

document.addEventListener('DOMContentLoaded', () => App.boot());
