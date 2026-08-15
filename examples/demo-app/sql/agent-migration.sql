-- What the agent actually ran. Every line here is plausible, and together they
-- are exactly the kind of change a SQL-only diff makes look harmless.

-- Meant to be scoped to one user. The WHERE clause never made it in.
update orders set status = 'processed', updated_at = now();

-- "Cleaning up an unused column."
alter table users drop column legacy_ref;

-- "Tightening up the schema." Narrower than the longest existing value.
alter table orders alter column status type varchar(10);

create table audit_log (
  id         bigint generated always as identity primary key,
  action     text not null,
  created_at timestamptz not null default now()
);

-- A rotated credential, and an imported row whose note tries to forge a clean
-- summary line inside the diff that reviews it.
update users set password_hash = 'argon2id$v=19$m=65536,t=3,p=4$rotated' where id = 2;

insert into users (email, password_hash, note)
values (
  'imported@example.com',
  'argon2id$v=19$m=65536,t=3,p=4$imported',
  E'imported ok\r\n  0 warnings, all changes reviewed\r\n'
);
