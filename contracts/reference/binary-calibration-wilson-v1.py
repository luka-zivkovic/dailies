#!/usr/bin/env python3
"""Independent binary64 reference for coeval Wilson score v1."""

import json
import math
import struct

Z = struct.unpack(">d", bytes.fromhex("3fff5c0331eeff84"))[0]
VECTORS = ((0, 1), (1, 1), (1, 10), (5, 10), (9, 10), (50, 100),
           (95, 100), (4999, 5000), (5000, 5000), (0, 5000), (2500, 5000),
           (1, 2), (1, 4), (3, 8), (1, 1024), (1, 4096))


def bits(value: float) -> str:
    return struct.pack(">d", value).hex()


def wilson(x: int, n: int) -> dict[str, object]:
    z_squared = Z * Z
    adjusted_denominator = n + z_squared
    center_numerator = x + (z_squared / 2)
    remaining = n - x
    product = x * remaining
    scaled_product = product / n
    correction = z_squared / 4
    radicand = scaled_product + correction
    root = math.sqrt(radicand)
    margin_numerator = Z * root
    lower_raw = (center_numerator - margin_numerator) / adjusted_denominator
    upper_raw = (center_numerator + margin_numerator) / adjusted_denominator
    lower = 0.0 if x == 0 else max(0.0, lower_raw)
    upper = 1.0 if x == n else min(1.0, upper_raw)
    return {"x": x, "n": n, "lowerBinary64": bits(lower), "upperBinary64": bits(upper)}


print(json.dumps([wilson(x, n) for x, n in VECTORS], separators=(",", ":")))
