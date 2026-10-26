# Connector tests

Real databases in Docker, then `test-driver.cjs` (driver → Parquet through DuckDB, prints counts/types/rows).

```bash
# SQL Server 2022 (port 14330) + test data
docker run -d --name mib-bi-mssql -e ACCEPT_EULA=Y -e MSSQL_SA_PASSWORD='MiBBI_Test_2026!' -p 14330:1433 mcr.microsoft.com/mssql/server:2022-latest
docker cp scripts/connectors/seed-sqlserver.sql mib-bi-mssql:/tmp/seed.sql
docker exec mib-bi-mssql /opt/mssql-tools18/bin/sqlcmd -C -S localhost -U sa -P 'MiBBI_Test_2026!' -i /tmp/seed.sql
node scripts/connectors/test-driver.cjs '{"kind":"sqlserver","host":"localhost","port":"14330","database":"Vendite","user":"lettore","trustCert":true}' 'Rd!Acc3ss_2026' dbo.Prodotti sales.Ordini

# Oracle Free 23 (port 15210), ClickHouse (18123), MongoDB (27018), BigQuery emulator (19050): see seed-*.{sql,js}
docker run -d --name mib-bi-oracle -p 15210:1521 -e ORACLE_PASSWORD='Rd_Acc3ss_2026' -e APP_USER=lettore -e APP_USER_PASSWORD='Rd_Acc3ss_2026' gvenzl/oracle-free:23-slim-faststart
docker run -d --name mib-bi-ch -p 18123:8123 -e CLICKHOUSE_USER=lettore -e CLICKHOUSE_PASSWORD='Rd!Acc3ss_2026' -e CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT=1 clickhouse/clickhouse-server:24.8
docker run -d --name mib-bi-mongo -p 27018:27017 -e MONGO_INITDB_ROOT_USERNAME=lettore -e MONGO_INITDB_ROOT_PASSWORD='Rd!Acc3ss_2026' mongo:7
docker run -d --name mib-bi-bq -p 19050:9050 -v $PWD/scripts/connectors/seed-bigquery.yaml:/seed.yaml:ro ghcr.io/goccy/bigquery-emulator:latest --project=mib-bi-test --data-from-yaml=/seed.yaml

# Access: sample files of andipaetzold/mdb-reader (test/data); ODBC without root: driver .so from `apt-get download libsqliteodbc`
node scripts/connectors/test-driver.cjs '{"kind":"access","file":"ASampleDatabase.accdb"}' - '.Asset Items'
node scripts/connectors/test-driver.cjs '{"kind":"odbc","host":"Driver=/path/libsqlite3odbc.so;Database=test.db"}' - .clienti

# Apache Polaris (Iceberg REST catalog, :8181): catalog "vendite" on local files, principal root / s3cr3t
sh scripts/connectors/seed-polaris.sh
```

These containers and passwords are local test fixtures only.
