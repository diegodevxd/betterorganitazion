-- Ejecutar en Supabase SQL Editor (después de movimientos.sql)
-- Permite editar registros desde la app

create policy "anon actualiza movimientos"
on movimientos for update to anon
using (true) with check (true);

create policy "anon actualiza asociados"
on asociados for update to anon
using (true) with check (true);

create policy "anon elimina movimientos"
on movimientos for delete to anon
using (true);

create policy "anon elimina asociados"
on asociados for delete to anon
using (true);
