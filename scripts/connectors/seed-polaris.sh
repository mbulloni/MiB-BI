#!/bin/sh
# Apache Polaris (Iceberg REST catalog) on :8181 with a FILE-storage catalog "vendite" and two tables written by DuckDB.
# Test fixture only: bootstrap principal root / s3cr3t. Usage: sh scripts/connectors/seed-polaris.sh
set -e
WH=${POLARIS_WH:-/tmp/mib-bi-polaris-wh}
mkdir -p "$WH" && chmod 777 "$WH"
docker run -d --name mib-bi-polaris -p 8181:8181 -p 8182:8182 -v "$WH:$WH" \
  -e POLARIS_BOOTSTRAP_CREDENTIALS=POLARIS,root,s3cr3t \
  -e 'polaris.features."ALLOW_INSECURE_STORAGE_TYPES"=true' \
  -e 'polaris.features."SUPPORTED_CATALOG_STORAGE_TYPES"=["FILE","S3"]' \
  -e 'polaris.readiness.ignore-severe-issues=true' apache/polaris:latest
until curl -sf localhost:8182/q/health >/dev/null; do sleep 2; done
TOK=$(curl -s -X POST localhost:8181/api/catalog/v1/oauth/tokens -d grant_type=client_credentials -d client_id=root -d client_secret=s3cr3t -d scope=PRINCIPAL_ROLE:ALL | sed 's/.*"access_token":"\([^"]*\)".*/\1/')
H="Authorization: Bearer $TOK"
curl -sf -X POST localhost:8181/api/management/v1/catalogs -H "$H" -H 'Content-Type: application/json' \
  -d "{\"catalog\":{\"name\":\"vendite\",\"type\":\"INTERNAL\",\"properties\":{\"default-base-location\":\"file://$WH/vendite\"},\"storageConfigInfo\":{\"storageType\":\"FILE\",\"allowedLocations\":[\"file://$WH\"]}}}" >/dev/null
curl -sf -X PUT localhost:8181/api/management/v1/catalogs/vendite/catalog-roles/catalog_admin/grants -H "$H" -H 'Content-Type: application/json' -d '{"grant":{"type":"catalog","privilege":"CATALOG_MANAGE_CONTENT"}}'
curl -sf -X PUT localhost:8181/api/management/v1/principal-roles/service_admin/catalog-roles/vendite -H "$H" -H 'Content-Type: application/json' -d '{"catalogRole":{"name":"catalog_admin"}}'
# DuckDB's local file system does not create the table folders
for t in ordini prodotti; do mkdir -p "$WH/vendite/retail/$t/metadata" "$WH/vendite/retail/$t/data"; done
chmod -R 777 "$WH"
node -e "
const { DuckDBInstance } = require('@duckdb/node-api');
(async () => {
  const c = await (await DuckDBInstance.create(':memory:')).connect();
  for (const s of [
    \"INSTALL iceberg; LOAD iceberg\",
    \"CREATE SECRET pol (TYPE ICEBERG, CLIENT_ID 'root', CLIENT_SECRET 's3cr3t', OAUTH2_SERVER_URI 'http://localhost:8181/api/catalog/v1/oauth/tokens', OAUTH2_SCOPE 'PRINCIPAL_ROLE:ALL')\",
    \"ATTACH 'vendite' AS cat (TYPE ICEBERG, ENDPOINT 'http://localhost:8181/api/catalog', SECRET pol)\",
    \"CREATE SCHEMA cat.retail\",
    \"CREATE TABLE cat.retail.prodotti AS SELECT i AS id, 'Prodotto ' || i AS nome, ['Bici','Accessori','Abbigliamento'][1 + i % 3] AS categoria FROM range(1, 21) t(i)\",
    \"CREATE TABLE cat.retail.ordini AS SELECT i AS id, 1 + i % 20 AS prodotti_id, DATE '2026-01-01' + (i % 300)::INT AS data, ['Nord','Centro','Sud'][1 + i % 3] AS area, round(random() * 500, 2)::DECIMAL(10,2) AS importo FROM range(1, 1001) t(i)\",
  ]) await c.run(s);
  console.log('Polaris pronto: catalogo vendite, tabelle retail.ordini (1000) e retail.prodotti (20)');
})();
"
