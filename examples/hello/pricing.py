def subtotal(items: list[dict]) -> float:
    return sum(item["price"] * item["quantity"] for item in items)


def order_total(items: list[dict], tax_rate: float) -> float:
    return subtotal(items) * (1 + tax_rate)
