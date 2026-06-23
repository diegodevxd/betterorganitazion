-- Ejecutar en Supabase SQL Editor
-- Unifica pagos + ventas en tabla movimientos

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

create policy "anon lee movimientos" on movimientos for select to anon using (true);
create policy "anon inserta movimientos" on movimientos for insert to anon with check (true);

-- Storage bucket movimientos_fotos
insert into storage.buckets (id, name, public)
values ('movimientos_fotos', 'movimientos_fotos', true)
on conflict (id) do update set public = true;

create policy "anon sube movimientos_fotos"
on storage.objects for insert to anon
with check (bucket_id = 'movimientos_fotos');

create policy "anon lee movimientos_fotos"
on storage.objects for select to anon
using (bucket_id = 'movimientos_fotos');
