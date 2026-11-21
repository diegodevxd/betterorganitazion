-- Ejecutar en Supabase SQL Editor
-- Unifica pagos + ventas en tabla movimientos y restringe acceso a administradores (public.es_admin())

-- IMPORTANTE: este script es idempotente y NO borra datos. La migración original
-- eliminaba las tablas antiguas `pagos` y `ventas` (drop table); eso ya se aplicó y
-- no debe repetirse. Si montas una base nueva desde cero no hace falta.

create table if not exists movimientos (
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

drop policy if exists "admins leen movimientos" on movimientos;
create policy "admins leen movimientos"
on movimientos for select to authenticated
using (public.es_admin());

drop policy if exists "admins insertan movimientos" on movimientos;
create policy "admins insertan movimientos"
on movimientos for insert to authenticated
with check (public.es_admin());

-- Storage bucket movimientos_fotos
insert into storage.buckets (id, name, public)
values ('movimientos_fotos', 'movimientos_fotos', true)
on conflict (id) do update set public = true;

drop policy if exists "admins suben movimientos_fotos" on storage.objects;
create policy "admins suben movimientos_fotos"
on storage.objects for insert to authenticated
with check (bucket_id = 'movimientos_fotos' and public.es_admin());

drop policy if exists "admins leen movimientos_fotos" on storage.objects;
create policy "admins leen movimientos_fotos"
on storage.objects for select to authenticated
using (bucket_id = 'movimientos_fotos' and public.es_admin());
