"""Independent spike-only oracle. No DuckDB or third-party Python packages."""
import csv
import decimal
import json
import sys

decimal.getcontext().prec = 80
if sys.argv[1] == "--compare":
    values = json.load(sys.stdin)
    expected = decimal.Decimal(values["expected"])
    results = {key: {"equal": decimal.Decimal(value) == expected,
                           "difference": str(decimal.Decimal(value) - expected)}
                      for key, value in values.items() if key != "expected"}
    exact_binary = decimal.Decimal.from_float(float(values["automatic"]))
    results["automaticBinaryExact"] = {"value": str(exact_binary), "equal": exact_binary == expected,
                                        "difference": str(exact_binary - expected)}
    print(json.dumps(results))
elif sys.argv[1] == "--types":
    with open(sys.argv[2], encoding="utf-8", newline="") as source:
        rows = list(csv.DictReader(source, strict=True))
    print(json.dumps({"moneySum": str(sum((decimal.Decimal(r["money"]) for r in rows), decimal.Decimal(0)))}))
else:
    with open(sys.argv[1], encoding="utf-8-sig", newline="") as source:
        reader = csv.DictReader(source, delimiter=",", strict=True)
        rows = list(reader)
        columns = reader.fieldnames
    assert columns and "quantidade" in columns and "preco_unitario" in columns
    assert all(None not in row and all(value is not None for value in row.values()) for row in rows)
    # Explicit DECIMAL(18,0)/(18,2) must not silently round a different input domain.
    for row in rows:
        if row["quantidade"] != "":
            quantity = decimal.Decimal(row["quantidade"])
            assert quantity == quantity.to_integral_value()
        if row["preco_unitario"] != "":
            price = decimal.Decimal(row["preco_unitario"])
            assert price == price.quantize(decimal.Decimal("0.01"))
    # Explicit policy shared with read_csv: empty strings (quoted or not) are NULL.
    products = [decimal.Decimal(row["quantidade"]) * decimal.Decimal(row["preco_unitario"])
                for row in rows if row["quantidade"] != "" and row["preco_unitario"] != ""]
    total = sum(products, decimal.Decimal(0)) if products else None
    print(json.dumps({"python": sys.version.split()[0], "rowCount": len(rows),
                      "columns": columns, "nullCounts": {c: sum(row[c] == "" for row in rows) for c in columns},
                      "aggregate": str(total) if total is not None else None,
                      "contributingRows": len(products)}, ensure_ascii=True))
