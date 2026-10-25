"""Extract a Power BI .pbix/.pbit into a folder MiB-BI can load.

Usage: read_pbix.py <file> <outdir>
Writes <outdir>/model.json and one Parquet file per imported table.
.pbix data model (XPress9-compressed VertiPaq) is decoded with pbixray;
.pbit only carries the schema (DataModelSchema), so no data is extracted.
"""
import base64
import json
import mimetypes
import os
import re
import sys
import zipfile

SKIP_TABLE = re.compile(r"^(LocalDateTable_|DateTableTemplate_)")
MAX_RESOURCE = 6 * 1024 * 1024


def utf16(z, name):
    raw = z.read(name)
    for enc in ("utf-16-le", "utf-8-sig"):
        try:
            text = raw.decode(enc)
            if text.lstrip("﻿").lstrip().startswith(("{", "[")):
                return text.lstrip("﻿")
        except UnicodeDecodeError:
            pass
    return raw.decode("utf-16-le", errors="replace").lstrip("﻿")


def safe_name(name, used):
    base = re.sub(r"[^\w.-]+", "_", name) or "table"
    out, i = base, 2
    while out in used:
        out, i = f"{base}_{i}", i + 1
    used.add(out)
    return out


def card(c):
    return {"M:1": "manyToOne", "1:M": "oneToMany", "1:1": "oneToOne", "M:M": "manyToMany"}.get(str(c), "manyToOne")


def support_idfx():
    """Recent Analysis Services engines (Power BI Desktop 2026, MiB-BI's own .pbix writer) store each column segment
    as one `.idfx` file = idf + idfmeta + u64 length of the idfmeta. pbixray asks for `X.idfx` / `X.idfxmeta`:
    serve both halves from the single file."""
    import struct
    import pbixray.utils as U
    import pbixray.vertipaq_decoder as VD
    import pbixray.meta.sqlite_source as SS
    original = U.get_data_slice

    def get_data_slice(data_model, file_name):
        if file_name.endswith('.idfxmeta') or file_name.endswith('.idfx'):
            base = file_name[:-4] if file_name.endswith('meta') else file_name
            d = bytes(original(data_model, base))
            n = struct.unpack_from('<Q', d, len(d) - 8)[0]
            return d[len(d) - 8 - n:len(d) - 8] if file_name.endswith('meta') else d[:len(d) - 8 - n]
        return original(data_model, file_name)
    for mod in (U, VD, SS):
        if hasattr(mod, 'get_data_slice'):
            mod.get_data_slice = get_data_slice


def from_pbixray(path, outdir, out):
    try:
        from pbixray import PBIXRay
    except ImportError:
        raise SystemExit("PBIXRAY_MISSING")
    support_idfx()
    import pandas as pd
    import decimal

    model = PBIXRay(path)
    pq = {}
    try:
        for _, r in model.power_query.iterrows():
            pq[r["TableName"]] = r["Expression"]
    except Exception:
        pass
    used = set()
    for name in [str(t) for t in model.tables]:
        if SKIP_TABLE.match(name):
            continue
        try:
            df = model.get_table(name)
        except Exception as e:  # noqa: BLE001 - keep importing other tables
            out["warnings"].append(f"Tabella {name}: {e}")
            continue
        for col in df.columns:
            s = df[col]
            if s.dtype == object:
                sample = next((v for v in s.head(200) if v is not None and v == v), None)
                if isinstance(sample, decimal.Decimal):
                    df[col] = pd.to_numeric(s.map(lambda v: float(v) if v is not None else None), errors="coerce")
                elif sample is not None and not isinstance(sample, str):
                    df[col] = s.map(lambda v: None if v is None else str(v))
        file = os.path.join(outdir, safe_name(name, used) + ".parquet")
        df.to_parquet(file, index=False)
        out["tables"].append({"name": name, "parquet": file, "rows": int(len(df)), "m": pq.get(name)})

    # Model metadata not exposed by pbixray's public API: "sort by column" and measure formats.
    sort_by, fmt, category = {}, {}, {}
    try:
        db = model._metadata.source._db
        q = db.query("SELECT t.Name AS T, c.ExplicitName AS C, s.ExplicitName AS S FROM [Column] c "
                     "JOIN [Table] t ON c.TableID = t.ID JOIN [Column] s ON c.SortByColumnID = s.ID")
        for _, r in q.iterrows():
            sort_by.setdefault(r["T"], {})[r["C"]] = r["S"]
        q = db.query("SELECT t.Name AS T, c.ExplicitName AS C, c.DataCategory AS D FROM [Column] c JOIN [Table] t ON c.TableID = t.ID "
                     "WHERE c.DataCategory IS NOT NULL AND c.DataCategory <> ''")
        for _, r in q.iterrows():
            if isinstance(r["D"], str) and r["D"] not in ("Uncategorized", "Regular"):
                category.setdefault(r["T"], {})[r["C"]] = r["D"]
        q = db.query("SELECT t.Name AS T, m.Name AS M, m.FormatString AS F FROM [Measure] m JOIN [Table] t ON m.TableID = t.ID")
        for _, r in q.iterrows():
            if isinstance(r["F"], str) and r["F"]:
                fmt[(r["T"], r["M"])] = r["F"]
    except Exception as e:  # noqa: BLE001 - metadata is optional
        out["warnings"].append(f"Metadati del modello parziali: {e}")
    try:
        model_extras_sqlite(model._metadata.source._db, out)
    except Exception as e:  # noqa: BLE001 - metadata is optional
        out["warnings"].append(f"Gerarchie, gruppi di calcolo o ruoli non letti: {e}")
    for t in out["tables"]:
        t["sortBy"] = sort_by.get(t["name"], {})
        t["dataCategory"] = category.get(t["name"], {})

    names = {t["name"] for t in out["tables"]}
    for _, r in model.relationships.iterrows():
        if r["FromTableName"] not in names or r["ToTableName"] not in names:
            continue
        out["relationships"].append({
            "fromTable": r["FromTableName"], "fromColumn": r["FromColumnName"],
            "toTable": r["ToTableName"], "toColumn": r["ToColumnName"],
            "cardinality": card(r["Cardinality"]),
            "crossFilter": "both" if str(r["CrossFilteringBehavior"]).lower().startswith("both") else "single",
            "active": bool(r["IsActive"]),
        })
    # "Apply security filter in both directions" (SecurityFilteringBehavior 2) is only in metadata.sqlitedb.
    try:
        q = model._metadata.source._db.query(
            "SELECT ft.Name AS FT, fc.ExplicitName AS FC, tt.Name AS TT, tc.ExplicitName AS TC FROM [Relationship] r "
            "JOIN [Table] ft ON r.FromTableID = ft.ID JOIN [Column] fc ON r.FromColumnID = fc.ID "
            "JOIN [Table] tt ON r.ToTableID = tt.ID JOIN [Column] tc ON r.ToColumnID = tc.ID WHERE r.SecurityFilteringBehavior = 2")
        both = {(x["FT"], x["FC"], x["TT"], x["TC"]) for _, x in q.iterrows()}
        for rel in out["relationships"]:
            if (rel["fromTable"], rel["fromColumn"], rel["toTable"], rel["toColumn"]) in both:
                rel["securityBoth"] = True
    except Exception:  # noqa: BLE001 - optional metadata
        pass
    try:
        for _, r in model.m_parameters.iterrows():
            out["parameters"].append({"name": r["ParameterName"], "expression": r["Expression"],
                                      **({"description": r["Description"]} if isinstance(r["Description"], str) else {})})
    except Exception:  # noqa: BLE001 - older pbixray / no parameters
        pass
    for _, r in model.dax_measures.iterrows():
        out["measures"].append({
            "table": r["TableName"], "name": r["Name"],
            "expression": r["Expression"] if isinstance(r["Expression"], str) else "",
            "formatString": fmt.get((r["TableName"], r["Name"]), ""),
        })


def text_of(v):
    return "\n".join(v) if isinstance(v, list) else (v or "")


def model_extras_sqlite(db, out):
    """User hierarchies, display folders, date tables, calculation groups and roles from metadata.sqlitedb."""
    mx = out["model"]

    def q(sql):
        try:
            return list(db.query(sql).iterrows())
        except Exception:  # noqa: BLE001 - older models lack some tables
            return []
    levels = {}
    for _, r in q("SELECT h.ID AS H, t.Name AS T, h.Name AS N, l.Name AS L, c.ExplicitName AS C, l.Ordinal AS O FROM [Hierarchy] h "
                  "JOIN [Table] t ON h.TableID = t.ID JOIN [Level] l ON l.HierarchyID = h.ID JOIN [Column] c ON l.ColumnID = c.ID"):
        levels.setdefault((r["H"], r["T"], r["N"]), []).append((int(r["O"]), r["L"], r["C"]))
    for (_, t, n), lv in levels.items():
        mx["hierarchies"].append({"table": t, "name": n, "levels": [{"name": l, "column": c} for _, l, c in sorted(lv)]})
    for sql in ("SELECT t.Name AS T, c.ExplicitName AS N, c.DisplayFolder AS F FROM [Column] c JOIN [Table] t ON c.TableID = t.ID",
                "SELECT t.Name AS T, m.Name AS N, m.DisplayFolder AS F FROM [Measure] m JOIN [Table] t ON m.TableID = t.ID",
                "SELECT t.Name AS T, h.Name AS N, h.DisplayFolder AS F FROM [Hierarchy] h JOIN [Table] t ON h.TableID = t.ID"):
        for _, r in q(sql):
            if isinstance(r["F"], str) and r["F"].strip():
                mx["folders"].append({"table": r["T"], "name": r["N"], "folder": r["F"]})
    for _, r in q("SELECT t.Name AS T, c.ExplicitName AS C FROM [Table] t JOIN [Column] c ON c.TableID = t.ID WHERE t.DataCategory = 'Time' AND c.IsKey = 1"):
        mx["dateTables"][r["T"]] = r["C"]
    groups = {}
    for _, r in q("SELECT g.ID AS G, t.Name AS T, g.Precedence AS P FROM [CalculationGroup] g JOIN [Table] t ON g.TableID = t.ID"):
        cols = [c["C"] for _, c in q(f"SELECT c.ExplicitName AS C FROM [Column] c JOIN [Table] t ON c.TableID = t.ID WHERE t.Name = '{str(r['T']).replace(chr(39), chr(39) * 2)}'")]
        col = next((c for c in cols if isinstance(c, str) and c != "Ordinal" and not c.startswith("RowNumber-")), "Name")
        groups[r["G"]] = {"table": r["T"], "column": col, "precedence": int(r["P"] or 0), "items": []}
    fmt = {r["I"]: r["E"] for _, r in q("SELECT ID AS I, Expression AS E FROM [FormatStringDefinition]")}
    for _, r in q("SELECT CalculationGroupID AS G, Name AS N, Expression AS E, Ordinal AS O, FormatStringDefinitionID AS F FROM [CalculationItem]"):
        g = groups.get(r["G"])
        if g is not None:
            item = {"name": r["N"], "expression": r["E"] if isinstance(r["E"], str) else "", "ordinal": int(r["O"] or 0)}
            if isinstance(fmt.get(r["F"]), str):
                item["formatString"] = fmt[r["F"]]
            g["items"].append(item)
    for g in groups.values():
        g["items"].sort(key=lambda i: i["ordinal"])
        mx["calcGroups"].append(g)
    roles = {}
    for _, r in q("SELECT ID AS I, Name AS N FROM [Role]"):
        roles[r["I"]] = {"name": r["N"], "filters": []}
    for _, r in q("SELECT p.RoleID AS R, t.Name AS T, p.FilterExpression AS E FROM [TablePermission] p JOIN [Table] t ON p.TableID = t.ID"):
        if r["R"] in roles and isinstance(r["E"], str) and r["E"].strip():
            roles[r["R"]]["filters"].append({"table": r["T"], "expression": r["E"]})
    mx["roles"].extend(roles.values())
    for _, r in q("SELECT Name AS N, Expression AS E, Description AS D FROM [Function]"):
        if isinstance(r["N"], str) and isinstance(r["E"], str):
            mx["functions"].append({"name": r["N"], "expression": r["E"], **({"description": r["D"]} if isinstance(r["D"], str) and r["D"] else {})})
    cals = {}
    for _, r in q("SELECT c.ID AS I, c.Name AS N, t.Name AS T, c.Description AS D FROM [Calendar] c JOIN [Table] t ON c.TableID = t.ID"):
        cals[r["I"]] = {"name": r["N"], "table": r["T"], "groups": [], **({"description": r["D"]} if isinstance(r["D"], str) and r["D"] else {})}
    groups = {}
    for _, r in q("SELECT ID AS I, CalendarID AS C, TimeUnit AS U FROM [CalendarColumnGroup]"):
        if r["C"] in cals:
            g = {"unit": TIME_UNITS.get(int(r["U"] or 0))}
            groups[r["I"]] = g
            cals[r["C"]]["groups"].append(g)
    for _, r in q("SELECT g.CalendarColumnGroupID AS G, COALESCE(c.ExplicitName, c.InferredName) AS C, g.IsPrimaryColumn AS P FROM [CalendarColumnReference] g JOIN [Column] c ON g.ColumnID = c.ID"):
        g = groups.get(r["G"])
        if g is None:
            continue
        if r["P"] and g["unit"]:
            g["primary"] = r["C"]
        else:
            g.setdefault("associated", []).append(r["C"])
    mx["calendars"].extend(cals.values())
    # Model translations: ObjectTranslation rows (ObjectType 3 table, 4 column, 8 measure, 9 hierarchy;
    # Property 1 caption, 2 description, 3 display folder) per Culture.
    keys = {}
    for _, r in q("SELECT ID AS I, Name AS N FROM [Table]"):
        keys[(3, r["I"])] = r["N"]
    for typ, sql in ((4, "SELECT c.ID AS I, t.Name AS T, COALESCE(c.ExplicitName, c.InferredName) AS N FROM [Column] c JOIN [Table] t ON c.TableID = t.ID"),
                     (8, "SELECT m.ID AS I, t.Name AS T, m.Name AS N FROM [Measure] m JOIN [Table] t ON m.TableID = t.ID"),
                     (9, "SELECT h.ID AS I, t.Name AS T, h.Name AS N FROM [Hierarchy] h JOIN [Table] t ON h.TableID = t.ID")):
        for _, r in q(sql):
            keys[(typ, r["I"])] = f"{r['T']}\u0001{r['N']}"
    cultures = {}
    for _, r in q("SELECT c.Name AS C, o.ObjectID AS O, o.ObjectType AS T, o.Property AS P, o.Value AS V FROM [ObjectTranslation] o JOIN [Culture] c ON o.CultureID = c.ID"):
        key = keys.get((int(r["T"] or 0), r["O"]))
        if key is None or not isinstance(r["V"], str) or not r["V"]:
            continue
        cu = cultures.setdefault(r["C"], {"name": r["C"], "captions": {}, "descriptions": {}, "folders": {}})
        slot = {1: "captions", 2: "descriptions", 3: "folders"}.get(int(r["P"] or 0))
        if slot:
            cu[slot][key] = r["V"]
    mx["cultures"].extend(cultures.values())


# TOM TimeUnit (Calendar column groups); 0 = time-related columns.
TIME_UNITS = {i: n for i, n in enumerate(["", "year", "semester", "semesterOfYear", "quarter", "quarterOfYear", "quarterOfSemester", "month", "monthOfYear",
                                            "monthOfSemester", "monthOfQuarter", "week", "weekOfYear", "weekOfSemester", "weekOfQuarter", "weekOfMonth", "date",
                                            "dayOfYear", "dayOfSemester", "dayOfQuarter", "dayOfMonth", "dayOfWeek"]) if n}


def model_extras_tmsl(model, out):
    """Same as model_extras_sqlite, from TMSL (DataModelSchema / model.bim)."""
    mx = out["model"]
    for f in model.get("functions", []):
        mx["functions"].append({"name": f["name"], "expression": text_of(f.get("expression")), **({"description": text_of(f["description"])} if f.get("description") else {})})
    for t in model.get("tables", []):
        name = t["name"]
        for c in t.get("calendars", []):
            groups = []
            for g in c.get("calendarColumnGroups", []):
                unit = g.get("timeUnit")
                if isinstance(unit, int):
                    unit = TIME_UNITS.get(unit)
                if unit and unit != "unknown":
                    groups.append({"unit": unit[0].lower() + unit[1:], "primary": g.get("primaryColumn"), **({"associated": g["associatedColumns"]} if g.get("associatedColumns") else {})})
                else:
                    groups.append({"unit": None, "associated": list(g.get("columns", []))})
            mx["calendars"].append({"name": c["name"], "table": name, "groups": groups, **({"description": text_of(c["description"])} if c.get("description") else {})})
        for h in t.get("hierarchies", []):
            lv = sorted(h.get("levels", []), key=lambda l: l.get("ordinal", 0))
            mx["hierarchies"].append({"table": name, "name": h["name"], "levels": [{"name": l["name"], "column": l["column"]} for l in lv]})
            if h.get("displayFolder"):
                mx["folders"].append({"table": name, "name": h["name"], "folder": h["displayFolder"]})
        for c in t.get("columns", []) + t.get("measures", []):
            if c.get("displayFolder"):
                mx["folders"].append({"table": name, "name": c["name"], "folder": c["displayFolder"]})
        if t.get("dataCategory") == "Time":
            key = next((c["name"] for c in t.get("columns", []) if c.get("isKey")), None)
            if key:
                mx["dateTables"][name] = key
        cg = t.get("calculationGroup")
        if cg is not None:
            col = next((c["name"] for c in t.get("columns", []) if c["name"] != "Ordinal" and c.get("type") != "rowNumber"), "Name")
            items = sorted(cg.get("calculationItems", []), key=lambda i: i.get("ordinal", 0))
            mx["calcGroups"].append({"table": name, "column": col, "precedence": int(cg.get("precedence", 0)), "items": [
                {"name": i["name"], "expression": text_of(i.get("expression")),
                 **({"formatString": text_of(i["formatStringDefinition"].get("expression"))} if i.get("formatStringDefinition") else {})}
                for i in items]})
    for r in model.get("roles", []):
        mx["roles"].append({"name": r["name"], "filters": [{"table": p["name"], "expression": text_of(p.get("filterExpression"))}
                                                          for p in r.get("tablePermissions", []) if text_of(p.get("filterExpression")).strip()]})
    for c in model.get("cultures", []):
        cu = {"name": c["name"], "captions": {}, "descriptions": {}, "folders": {}}

        def put(key, o):
            for src, slot in (("translatedCaption", "captions"), ("translatedDescription", "descriptions"), ("translatedDisplayFolder", "folders")):
                if isinstance(o.get(src), str) and o[src]:
                    cu[slot][key] = o[src]
        for t in (c.get("translations") or {}).get("model", {}).get("tables", []):
            put(t["name"], t)
            for x in t.get("columns", []) + t.get("measures", []) + t.get("hierarchies", []):
                put(f"{t['name']}\u0001{x['name']}", x)
        mx["cultures"].append(cu)


def from_schema(z, out):
    schema = json.loads(utf16(z, "DataModelSchema"))
    model = schema.get("model", {})
    model_extras_tmsl(model, out)
    for t in model.get("tables", []):
        name = t["name"]
        if SKIP_TABLE.match(name):
            continue
        m = dax = None
        for p in t.get("partitions", []):
            src = p.get("source", {})
            expr = src.get("expression")
            if expr is not None:
                text = "\n".join(expr) if isinstance(expr, list) else expr
                if src.get("type") == "calculated":
                    dax = text  # calculated table (DAX)
                else:
                    m = text
        calc = [{"name": c["name"], "expression": "\n".join(c["expression"]) if isinstance(c.get("expression"), list) else c.get("expression", "")}
                for c in t.get("columns", []) if c.get("type") == "calculated"]
        cols = [{"name": c["name"], "dataType": c.get("dataType", "string")}
                for c in t.get("columns", []) if c.get("type") not in ("rowNumber", "calculated") and not c["name"].startswith("RowNumber-")]
        all_hidden = all(c.get("isHidden") for c in t.get("columns", []) if c.get("type") != "rowNumber")
        measure_table = bool(t.get("measures")) and all_hidden
        sort_by = {c["name"]: c["sortByColumn"] for c in t.get("columns", []) if c.get("sortByColumn")}
        category = {c["name"]: c["dataCategory"] for c in t.get("columns", []) if c.get("dataCategory") and c["dataCategory"] not in ("Uncategorized", "Regular")}
        if not measure_table:  # measure tables only carry measures
            out["tables"].append({"name": name, "parquet": None, "rows": 0, "m": m, "columns": cols, "sortBy": sort_by, "dataCategory": category,
                                  **({"dax": dax} if dax else {}), **({"calcColumns": calc} if calc else {})})
        for ms in t.get("measures", []):
            expr = ms.get("expression", "")
            out["measures"].append({"table": name, "name": ms["name"],
                                    "expression": "\n".join(expr) if isinstance(expr, list) else expr,
                                    "formatString": ms.get("formatString", "")})
    for e in model.get("expressions", []):
        text = "\n".join(e["expression"]) if isinstance(e.get("expression"), list) else e.get("expression", "")
        if re.search(r"IsParameterQuery\s*=\s*true", text or "", re.I):
            out["parameters"].append({"name": e["name"], "expression": text, **({"description": e["description"]} if e.get("description") else {})})
    names = {t["name"] for t in out["tables"]}
    for r in model.get("relationships", []):
        if r["fromTable"] not in names or r["toTable"] not in names:
            continue
        fc, tc = r.get("fromCardinality", "many"), r.get("toCardinality", "one")
        cardinality = "oneToOne" if fc == "one" and tc == "one" else "manyToMany" if tc == "many" else "manyToOne"
        out["relationships"].append({
            "fromTable": r["fromTable"], "fromColumn": r["fromColumn"], "toTable": r["toTable"], "toColumn": r["toColumn"],
            "cardinality": cardinality,
            "crossFilter": "both" if r.get("crossFilteringBehavior") == "bothDirections" else "single",
            "active": r.get("isActive", True),
            "securityBoth": r.get("securityFilteringBehavior") == "bothDirections",
        })


CV_PART = re.compile(r"^Report/CustomVisuals/([^/]+)/(package\.json|resources/[^/]+\.pbiviz\.json)$")


def custom_visuals(z, names):
    """Custom visuals embedded in the report: Report/CustomVisuals/<guid>/package.json + resources/<guid>.pbiviz.json."""
    found = {}
    for n in names:
        m = CV_PART.match(n)
        if not m:
            continue
        try:
            data = json.loads(z.read(n).decode("utf-8-sig"))
        except (ValueError, UnicodeDecodeError):
            continue
        found.setdefault(m.group(1), {"guid": m.group(1)})["package" if m.group(2) == "package.json" else "pbiviz"] = data
    return [v for v in found.values() if "pbiviz" in v]


def sensitivity(xml):
    """Microsoft Purview sensitivity label of the file (docProps/custom.xml MSIP_Label_<id>_* properties)."""
    props = dict(re.findall(r'name="MSIP_Label_([0-9a-fA-F-]+_[A-Za-z]+)"><vt:lpwstr>([^<]*)</vt:lpwstr>', xml))
    for key, value in props.items():
        label_id, field = key.rsplit("_", 1)
        if field == "Enabled" and value.lower() == "true":
            return {"id": label_id, "name": props.get(label_id + "_Name", "Etichetta"), "tenant": props.get(label_id + "_SiteId")}
    return None


def main():
    path, outdir = sys.argv[1], sys.argv[2]
    os.makedirs(outdir, exist_ok=True)
    out = {"file": path, "kind": None, "tables": [], "relationships": [], "measures": [],
           "layout": None, "resources": {}, "customVisuals": [], "parameters": [], "warnings": [],
           "model": {"hierarchies": [], "folders": [], "dateTables": {}, "calcGroups": [], "roles": [], "functions": [], "calendars": [], "cultures": []}}
    with zipfile.ZipFile(path) as z:
        names = z.namelist()
        if "Report/Layout" in names:
            out["layout"] = utf16(z, "Report/Layout")
        elif any(n.startswith("Report/definition/") for n in names):
            # Enhanced report format (PBIR): JSON files per page/visual, converted in src/pbix/pbir.ts.
            out["pbir"] = {n[len("Report/definition/"):]: z.read(n).decode("utf-8-sig")
                           for n in names if n.startswith("Report/definition/") and n.endswith(".json")}
        for n in names:
            if n.startswith("Report/StaticResources/RegisteredResources/") and z.getinfo(n).file_size <= MAX_RESOURCE:
                mime = mimetypes.guess_type(n)[0] or "application/octet-stream"
                if mime.startswith("image/") or mime == "application/json":
                    out["resources"][n.rsplit("/", 1)[1]] = f"data:{mime};base64," + base64.b64encode(z.read(n)).decode()
        out["customVisuals"] = custom_visuals(z, names)
        if "docProps/custom.xml" in names:
            label = sensitivity(z.read("docProps/custom.xml").decode("utf-8", "replace"))
            if label:
                out["sensitivity"] = label
        if "DataModel" in names:
            out["kind"] = "pbix"
            from_pbixray(path, outdir, out)
        elif "DataModelSchema" in names:
            out["kind"] = "pbit"
            from_schema(z, out)
        else:
            out["kind"] = "live"
            out["warnings"].append("Il file usa una connessione dinamica a un modello remoto (Power BI Service / Analysis Services): non contiene dati.")
    with open(os.path.join(outdir, "model.json"), "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, allow_nan=False, default=str)
    print(os.path.join(outdir, "model.json"))


if __name__ == "__main__":
    main()
