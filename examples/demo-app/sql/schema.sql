-- A small shop, the state of the database before the agent touches it.

create table users (
  id            bigint generated always as identity primary key,
  email         text not null unique,
  password_hash text not null,
  tier          text not null default 'free',
  legacy_ref    text,
  note          text,
  created_at    timestamptz not null default now()
);

create table orders (
  id         bigint generated always as identity primary key,
  user_id    bigint not null references users (id),
  status     varchar(20) not null default 'pending',
  total      numeric(10,2) not null default 0,
  updated_at timestamptz not null default now()
);

create index orders_status_idx on orders (status);

insert into users (email, password_hash, legacy_ref)
select
  'user' || g || '@example.com',
  'argon2id$v=19$m=65536,t=3,p=4$' || md5(g::text),
  'legacy-' || g
from generate_series(1, 40) g;

insert into orders (user_id, status, total)
select
  (g % 40) + 1,
  case when g % 100 = 0 then 'failed' else 'pending' end,
  (g % 500)::numeric + 0.99
from generate_series(1, 14203) g;
