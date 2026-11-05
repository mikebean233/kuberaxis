-- Credit card downloads list the payment from checking as a credit named "PAYMENT THANK YOU". It's the other
-- side of the checking account's "To Credit Card" transfer, so it counts as neither spending nor income.
INSERT INTO category_rules (priority, match_type, pattern, direction, category_id)
SELECT 10, 'contains', 'PAYMENT THANK YOU', 'credit', c.id
FROM categories c
WHERE lower(c.name) = 'credit card payment'
ON CONFLICT (match_type, pattern, direction) DO NOTHING;
