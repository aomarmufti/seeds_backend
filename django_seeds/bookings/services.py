"""
Business rules live here, NOT in views. Views translate HTTP <-> Python;
services decide what the business actually does. Same split as your
lib/pricing.js (rules) vs api/bookings.js (HTTP handler).
"""

# Integer pence, same convention as lib/pricing.js.
_RATES_PENCE = {"default": 4000, "A-Level": 4500}


def price_for(subject: str) -> int:
    return _RATES_PENCE.get(subject, _RATES_PENCE["default"])
