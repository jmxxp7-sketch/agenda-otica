# Setup Supabase

Este projeto usa Supabase Auth e tabelas públicas com RLS. Nao precisa Edge Function.

## 1. Banco

No Supabase, abra `SQL Editor` e rode o arquivo:

```bash
supabase/schema.sql
```

Se estiver no Mac, copie o SQL com:

```bash
pbcopy < supabase/schema.sql
```

Depois cole no `SQL Editor` e clique em `Run`.

## 2. Auth

Em `Authentication > Providers > Email`:

- deixe Email ativo
- desative confirmacao de email
- deixe cadastro/signup habilitado

O app mostra apenas nick e senha. Internamente o nick vira um email fake como `loja-centro@agenda.local`.

## 3. Frontend

As chaves públicas já estão em `js/supabase.js`:

```js
const SUPABASE_URL = 'https://ubcgavzrlyadjyvykezt.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_iDH3ekWIKam64pJPZn1kgg_pLR8AmaL';
```

Nunca coloque `service_role` no frontend.

## 4. Primeiro uso

1. Abra o app.
2. Clique em `Criar admin`.
3. Crie o admin com nick e senha.
4. Entre como admin.
5. Va em `Admin` > `Nova loja` para criar loja com nick e senha.

As lojas conseguem ver a agenda geral, mas so podem criar/editar dados da propria loja.
