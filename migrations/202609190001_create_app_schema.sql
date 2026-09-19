-- Up Migration
CREATE SCHEMA app;

-- Down Migration
-- RESTRICT impede remover um schema que já contenha objetos.
DROP SCHEMA app RESTRICT;
