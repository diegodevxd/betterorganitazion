-- Ejecutar en Supabase SQL Editor
-- Unifica pagos + ventas en tabla movimientos y restringe acceso a administradores (public.es_admin())

drop table if exists pagos;
drop table if exists ventas;

create table movimientos (
  id bigint generated always as identity primary key,
  cliente text not null,
  tipo text not null check (tipo in ('pedido', 'pago')),
  monto numeric not null check (monto > 0),
  descripcion text,
  url_foto text,
  array_urls_fotos jsonb default '[]',
  fecha date default current_date,
  hora time,
  created_at timestamptz default now()
);

alter table movimientos enable row level security;

create policy "admins leen movimientos"
on movimientos for select to authenticated
using (public.es_admin());

create policy "admins insertan movimientos"
on movimientos for insert to authenticated
with check (public.es_admin());

-- Storage bucket movimientos_fotos
insert into storage.buckets (id, name, public)
values ('movimientos_fotos', 'movimientos_fotos', true)
on conflict (id) do update set public = true;

create policy "admins suben movimientos_fotos"
on storage.objects for insert to authenticated
with check (bucket_id = 'movimientos_fotos' and public.es_admin());

create policy "admins leen movimientos_fotos"
on storage.objects for select to authenticated
using (bucket_id = 'movimientos_fotos' and public.es_admin());
