-- Producto de prueba para validar el flujo de pago con Stripe (monto bajo: $20 MXN).
-- Ejecutar en Supabase SQL Editor.
-- El monto minimo que acepta la Edge Function create-payment-intent es $10 MXN,
-- asi que $20 MXN pasa sin problema.

INSERT INTO productos (codigo, nombre, categoria, precio_regular, precio_oferta)
VALUES ('TEST20', 'Producto de Prueba Stripe', 'Prueba', 20.0, 20.0)
ON CONFLICT (codigo) DO UPDATE
SET nombre = EXCLUDED.nombre,
    categoria = EXCLUDED.categoria,
    precio_regular = EXCLUDED.precio_regular,
    precio_oferta = EXCLUDED.precio_oferta;

-- Para eliminarlo despues de probar:
-- DELETE FROM productos WHERE codigo = 'TEST20';
