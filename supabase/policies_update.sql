-- Ejecutar en Supabase SQL Editor (después de movimientos.sql y de crear public.es_admin())
-- Permite editar y eliminar registros únicamente a administradores autenticados

create policy "admins actualizan movimientos"
on movimientos for update to authenticated
using (public.es_admin()) with check (public.es_admin());

create policy "admins actualizan asociados"
on asociados for update to authenticated
using (public.es_admin()) with check (public.es_admin());

create policy "admins eliminan movimientos"
on movimientos for delete to authenticated
using (public.es_admin());

create policy "admins eliminan asociados"
on asociados for delete to authenticated
using (public.es_admin());
