-- Rules that categorize transactions automatically. A rule matches a transaction when its pattern is found in
-- the transaction's type, description and detail lines (case-insensitive). The first enabled rule by
-- (priority, id) wins, so put specific rules (e.g. "SAFEWAY FUEL") at a lower priority number than broad ones
-- ("SAFEWAY"). See src/categoryRules.ts.
CREATE TABLE category_rules (
  id          serial PRIMARY KEY,
  -- 'contains': plain substring. 'regex': PostgreSQL regular expression (use \m and \M for word boundaries).
  match_type  text NOT NULL CHECK (match_type IN ('contains', 'regex')),
  pattern     text NOT NULL CHECK (pattern <> ''),
  -- 'debit' only matches money out, 'credit' only money in.
  direction   text NOT NULL DEFAULT 'any' CHECK (direction IN ('any', 'debit', 'credit')),
  category_id integer NOT NULL REFERENCES categories (id) ON DELETE CASCADE,
  priority    integer NOT NULL DEFAULT 100,
  enabled     boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (match_type, pattern, direction)
);

-- The category of a transaction as a whole. Ignored when the transaction is itemized (its items' categories
-- apply instead). category_rule_id records which rule set it; NULL means it was set by hand.
ALTER TABLE transactions
  ADD COLUMN category_id      integer REFERENCES categories (id) ON DELETE SET NULL,
  ADD COLUMN category_rule_id integer REFERENCES category_rules (id) ON DELETE SET NULL;

CREATE INDEX transactions_category_idx ON transactions (category_id);

-- Starter rules for common national chains and bank transaction types. Rules whose category was renamed or
-- removed are skipped.
INSERT INTO category_rules (priority, match_type, pattern, direction, category_id)
SELECT v.priority, v.match_type, v.pattern, v.direction, c.id
FROM (
  VALUES
    -- Bank transaction types
    (10, 'contains', 'Interest Paid', 'credit', 'Interest'),
    (10, 'contains', 'ATM Withdrawal', 'debit', 'Cash'),
    (10, 'contains', 'Debit Purchase Ret', 'credit', 'Refunds'),
    (10, 'contains', 'To Credit Card', 'debit', 'Credit Card Payment'),
    (10, 'contains', 'Internet Banking Transfer', 'any', 'Transfers'),
    (10, 'contains', 'PAYROLL', 'credit', 'Paycheck'),

    -- Specific names that a broader rule below would otherwise catch
    (20, 'contains', 'SAFEWAY FUEL', 'any', 'Fuel'),
    (20, 'contains', 'COSTCO GAS', 'any', 'Fuel'),
    (20, 'contains', 'FRED M FUEL', 'any', 'Fuel'),
    (20, 'contains', 'LES SCHWAB', 'any', 'Auto Maintenance'),
    (20, 'contains', 'PRIME VIDEO', 'any', 'Streaming'),
    (20, 'contains', 'AMAZON PRIME', 'any', 'Software & Subscriptions'),
    (20, 'contains', 'UBER *EATS', 'any', 'Restaurants'),
    (20, 'contains', 'UBER EATS', 'any', 'Restaurants'),

    -- Fast food
    (50, 'contains', 'MCDONALD''S', 'any', 'Fast Food'),
    (50, 'contains', 'TACO BELL', 'any', 'Fast Food'),
    (50, 'contains', 'JACK IN THE BOX', 'any', 'Fast Food'),
    (50, 'regex', 'CARL''?S JR', 'any', 'Fast Food'),
    (50, 'contains', 'BURGER KING', 'any', 'Fast Food'),
    (50, 'contains', 'WENDY''S', 'any', 'Fast Food'),
    (50, 'regex', '\mKFC\M', 'any', 'Fast Food'),
    (50, 'regex', 'ARBY''?S', 'any', 'Fast Food'),
    (50, 'regex', '\mSUBWAY\M', 'any', 'Fast Food'),
    (50, 'contains', 'CHIPOTLE', 'any', 'Fast Food'),
    (50, 'contains', 'PANDA EXPRESS', 'any', 'Fast Food'),
    (50, 'contains', 'SONIC DRIVE', 'any', 'Fast Food'),
    (50, 'contains', 'DAIRY QUEEN', 'any', 'Fast Food'),
    (50, 'contains', 'TACO TIME', 'any', 'Fast Food'),
    (50, 'contains', 'DEL TACO', 'any', 'Fast Food'),
    (50, 'contains', 'CHICK-FIL-A', 'any', 'Fast Food'),
    (50, 'contains', 'POPEYES', 'any', 'Fast Food'),
    (50, 'regex', 'FIVE GUYS|\m5GUYS', 'any', 'Fast Food'),
    (50, 'contains', 'RAISING CANE', 'any', 'Fast Food'),
    (50, 'contains', 'CINNABON', 'any', 'Fast Food'),
    (50, 'contains', 'IN-N-OUT', 'any', 'Fast Food'),
    (50, 'contains', 'WHATABURGER', 'any', 'Fast Food'),
    (50, 'contains', 'JIMMY JOHN', 'any', 'Fast Food'),
    (50, 'regex', '\mFREDDYS\M', 'any', 'Fast Food'),
    (50, 'contains', 'KRISPY KREME', 'any', 'Fast Food'),
    (50, 'regex', 'DOMINO''?S', 'any', 'Fast Food'),
    (50, 'contains', 'PAPA JOHN', 'any', 'Fast Food'),
    (50, 'contains', 'PIZZA HUT', 'any', 'Fast Food'),
    (50, 'contains', 'LITTLE CAESARS', 'any', 'Fast Food'),
    (50, 'contains', 'PAPA MURPHY', 'debit', 'Fast Food'),

    -- Coffee
    (50, 'contains', 'STARBUCKS', 'any', 'Coffee'),
    (50, 'contains', 'DUTCH BROS', 'any', 'Coffee'),
    (50, 'contains', 'DUNKIN', 'any', 'Coffee'),
    (50, 'contains', 'PEET''S', 'any', 'Coffee'),
    (50, 'contains', 'TIM HORTONS', 'any', 'Coffee'),

    -- Restaurants
    (50, 'contains', 'TST*', 'any', 'Restaurants'),
    (50, 'contains', 'APPLEBEES', 'any', 'Restaurants'),
    (50, 'contains', 'RED ROBIN', 'any', 'Restaurants'),
    (50, 'contains', 'OUTBACK', 'any', 'Restaurants'),
    (50, 'contains', 'OLIVE GARDEN', 'any', 'Restaurants'),
    (50, 'contains', 'P.F.CHANG', 'any', 'Restaurants'),
    (50, 'contains', 'CHILI''S', 'any', 'Restaurants'),
    (50, 'contains', 'CRACKER BARREL', 'any', 'Restaurants'),
    (50, 'contains', 'DENNY''S', 'any', 'Restaurants'),
    (50, 'regex', '\mIHOP\M', 'any', 'Restaurants'),
    (50, 'contains', 'BUFFALO WILD', 'any', 'Restaurants'),
    (50, 'contains', 'TEXAS ROADHOUSE', 'any', 'Restaurants'),
    (50, 'contains', 'CHEESECAKE FACTORY', 'any', 'Restaurants'),
    (50, 'contains', 'DOORDASH', 'any', 'Restaurants'),
    (50, 'contains', 'GRUBHUB', 'any', 'Restaurants'),

    -- Groceries
    (50, 'contains', 'ALBERTSONS', 'any', 'Groceries'),
    (50, 'contains', 'SAFEWAY', 'any', 'Groceries'),
    (50, 'contains', 'KROGER', 'any', 'Groceries'),
    (50, 'regex', 'FRED[- ]MEYER', 'any', 'Groceries'),
    (50, 'contains', 'COSTCO WHSE', 'any', 'Groceries'),
    (50, 'contains', 'TRADER JOE', 'any', 'Groceries'),
    (50, 'regex', 'WHOLE ?FOODS|WHOLEFDS', 'any', 'Groceries'),
    (50, 'regex', '\mALDI\M', 'any', 'Groceries'),
    (50, 'contains', 'WINCO', 'any', 'Groceries'),
    (50, 'regex', '\mYOKES\M', 'any', 'Groceries'),
    (50, 'contains', 'PUBLIX', 'any', 'Groceries'),
    (50, 'contains', 'SPROUTS', 'any', 'Groceries'),
    (50, 'contains', 'WM SUPERCENTER', 'any', 'Groceries'),
    (50, 'contains', 'WAL-MART', 'any', 'Groceries'),

    -- Fuel
    (50, 'regex', '\mSHELL\M', 'any', 'Fuel'),
    (50, 'contains', 'EXXON', 'any', 'Fuel'),
    (50, 'contains', 'CHEVRON', 'any', 'Fuel'),
    (50, 'contains', 'MAVERIK', 'any', 'Fuel'),
    (50, 'regex', '\mARCO\M', 'any', 'Fuel'),
    (50, 'contains', 'CONOCO', 'any', 'Fuel'),
    (50, 'contains', 'PHILLIPS 66', 'any', 'Fuel'),
    (50, 'contains', 'SINCLAIR', 'any', 'Fuel'),
    (50, 'contains', 'VALERO', 'any', 'Fuel'),
    (50, 'contains', 'CIRCLE K', 'any', 'Fuel'),

    -- Health, pets
    (50, 'contains', 'WALGREENS', 'any', 'Health & Medical'),
    (50, 'regex', '\mCVS\M', 'any', 'Health & Medical'),
    (50, 'contains', 'RITE AID', 'any', 'Health & Medical'),
    (50, 'contains', 'LABCORP', 'any', 'Health & Medical'),
    (50, 'contains', 'PETSMART', 'any', 'Pets'),
    (50, 'contains', 'PETCO', 'any', 'Pets'),
    (50, 'contains', 'CHEWY', 'any', 'Pets'),
    (50, 'contains', 'ANIMAL HOSP', 'any', 'Pets'),

    -- Home
    (50, 'contains', 'HOME DEPOT', 'any', 'Home Improvement'),
    (50, 'regex', '\mLOWE''?S\M', 'any', 'Home Improvement'),
    (50, 'contains', 'ACE HARDWARE', 'any', 'Home Improvement'),
    (50, 'contains', 'MENARDS', 'any', 'Home Improvement'),
    (50, 'contains', 'HARBOR FREIGHT', 'any', 'Home Improvement'),
    (50, 'contains', 'WAYFAIR', 'any', 'Furniture & Decor'),
    (50, 'contains', 'HOMEGOODS', 'any', 'Furniture & Decor'),
    (50, 'regex', '\mIKEA\M', 'any', 'Furniture & Decor'),
    (50, 'contains', 'MORTGAGE', 'debit', 'Mortgage'),
    (50, 'contains', 'MR.COOPER', 'debit', 'Mortgage'),

    -- Auto
    (50, 'contains', 'AUTOZONE', 'any', 'Auto Maintenance'),
    (50, 'contains', 'O''REILLY', 'any', 'Auto Maintenance'),
    (50, 'contains', 'NAPA AUTO', 'any', 'Auto Maintenance'),
    (50, 'contains', 'JIFFY LUBE', 'any', 'Auto Maintenance'),
    (50, 'contains', 'SAFELITE', 'any', 'Auto Maintenance'),
    (50, 'contains', 'DISCOUNT TIRE', 'any', 'Auto Maintenance'),
    (50, 'contains', 'CAR WASH', 'any', 'Auto Maintenance'),
    (50, 'contains', 'GEICO', 'any', 'Auto Insurance'),
    (50, 'contains', 'PROGRESSIVE', 'any', 'Auto Insurance'),
    (50, 'contains', 'STATE FARM', 'any', 'Auto Insurance'),
    (50, 'contains', 'ALLSTATE', 'any', 'Auto Insurance'),
    (50, 'regex', '\mDMV\M', 'any', 'Vehicle Registration'),
    (50, 'contains', 'WSDOT', 'debit', 'Vehicle Registration'),

    -- Internet & phone
    (50, 'regex', 'COMCAST|XFINITY', 'any', 'Internet & Phone'),
    (50, 'contains', 'CENTURYL', 'any', 'Internet & Phone'),
    (50, 'contains', 'SPECTRUM', 'any', 'Internet & Phone'),
    (50, 'contains', 'VERIZON', 'any', 'Internet & Phone'),
    (50, 'contains', 'T-MOBILE', 'any', 'Internet & Phone'),
    (50, 'regex', '\mAT&T\M|\mATT\*', 'any', 'Internet & Phone'),
    (50, 'contains', 'CRICKET WIR', 'any', 'Internet & Phone'),

    -- Streaming and software
    (50, 'contains', 'NETFLIX', 'any', 'Streaming'),
    (50, 'contains', 'HULU', 'any', 'Streaming'),
    (50, 'regex', 'DISNEY ?PLUS', 'any', 'Streaming'),
    (50, 'contains', 'SPOTIF', 'any', 'Streaming'),
    (50, 'contains', 'HBO MAX', 'any', 'Streaming'),
    (50, 'contains', 'PARAMOUNT+', 'any', 'Streaming'),
    (50, 'contains', 'PEACOCK', 'any', 'Streaming'),
    (50, 'contains', 'YOUTUBE', 'any', 'Streaming'),
    (50, 'contains', 'JETBRAINS', 'any', 'Software & Subscriptions'),
    (50, 'contains', 'GITHUB', 'any', 'Software & Subscriptions'),
    (50, 'contains', 'OPENAI', 'any', 'Software & Subscriptions'),
    (50, 'regex', 'CLAUDE\.AI|ANTHROPIC', 'any', 'Software & Subscriptions'),
    (50, 'regex', 'SQSP\*|SQUARESPACE', 'any', 'Software & Subscriptions'),
    (50, 'contains', 'GOOGLE *', 'any', 'Software & Subscriptions'),
    (50, 'contains', 'APPLE.COM/BI', 'any', 'Software & Subscriptions'),
    (50, 'contains', 'MICROSOFT', 'any', 'Software & Subscriptions'),
    (50, 'contains', 'ADOBE', 'any', 'Software & Subscriptions'),
    (50, 'contains', 'DROPBOX', 'any', 'Software & Subscriptions'),

    -- Shopping and electronics
    (50, 'contains', 'BEST BUY', 'any', 'Electronics'),
    (50, 'contains', 'APPLE STORE', 'any', 'Electronics'),
    (50, 'contains', 'GOOGLE STORE', 'any', 'Electronics'),
    (50, 'contains', 'MICRO CENTER', 'any', 'Electronics'),
    (50, 'contains', 'NEWEGG', 'any', 'Electronics'),
    (50, 'regex', 'WM\.COM|WALMART\.COM', 'any', 'Shopping'),
    (50, 'regex', '\mTARGET\M', 'any', 'Shopping'),
    (50, 'regex', '\mEBAY\M', 'any', 'Shopping'),
    (50, 'regex', '\mETSY\M', 'any', 'Shopping'),
    (50, 'contains', 'VICTORIA''S SECRE', 'any', 'Clothing'),
    (50, 'contains', 'OLD NAVY', 'any', 'Clothing'),
    (50, 'contains', 'NORDSTROM', 'any', 'Clothing'),
    (50, 'contains', 'HOBBY LOBBY', 'any', 'Hobbies'),
    (50, 'contains', 'HOBBYLOBBY', 'any', 'Hobbies'),
    (50, 'regex', 'BARNES ?(&|AND)? ?NOBLE', 'any', 'Hobbies'),

    -- Entertainment and travel
    (50, 'contains', 'STUBHUB', 'any', 'Entertainment'),
    (50, 'contains', 'TICKETMASTER', 'any', 'Entertainment'),
    (50, 'contains', 'CHUCK E CHEESE', 'any', 'Entertainment'),
    (50, 'contains', 'AMC THEATRES', 'any', 'Entertainment'),
    (50, 'regex', '\mREGAL\M', 'any', 'Entertainment'),
    (50, 'contains', 'KINDLE', 'any', 'Entertainment'),
    (50, 'contains', 'ALASKA AIR', 'any', 'Travel'),
    (50, 'contains', 'SOUTHWES', 'any', 'Travel'),
    (50, 'contains', 'DELTA AIR', 'any', 'Travel'),
    (50, 'contains', 'UNITED AIRLINES', 'any', 'Travel'),
    (50, 'contains', 'AMERICAN AIR', 'any', 'Travel'),
    (50, 'contains', 'AIRBNB', 'any', 'Travel'),
    (50, 'contains', 'EXPEDIA', 'any', 'Travel'),
    (50, 'contains', 'MARRIOTT', 'any', 'Travel'),
    (50, 'contains', 'HILTON', 'any', 'Travel'),
    (50, 'contains', 'UBER *TRIP', 'debit', 'Travel'),

    -- Obligations and investments
    (50, 'regex', 'TURBOTAX|INTUIT \*TUR', 'any', 'Taxes'),
    (50, 'contains', 'IRS TREAS', 'any', 'Taxes'),
    (50, 'regex', 'DEPT EDUCATION|NELNET|NAVIENT|MOHELA', 'debit', 'Student Loans'),
    (50, 'regex', 'FID BKG|FIDELITY|VANGUARD|ROBINHOOD|E\*TRADE', 'any', 'Investments'),

    -- Broad catch-alls, after everything more specific
    (90, 'contains', 'AMAZON', 'any', 'Shopping'),
    (90, 'contains', 'AMZN', 'any', 'Shopping'),
    (90, 'contains', 'CAFE', 'debit', 'Restaurants')
) AS v (priority, match_type, pattern, direction, category)
JOIN categories c ON lower(c.name) = lower(v.category)
ON CONFLICT (match_type, pattern, direction) DO NOTHING;
