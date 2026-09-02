CREATE TABLE IF NOT EXISTS news (
    id TEXT PRIMARY KEY,

    source_url TEXT NOT NULL UNIQUE,
    source_name TEXT NOT NULL,

    source_title TEXT NOT NULL,
    source_description TEXT,

    headline TEXT,
    summary TEXT,

    main_topic TEXT,
    category TEXT NOT NULL,

    image_url TEXT,

    published_at TEXT NOT NULL,
    created_at TEXT NOT NULL,  -- ISO তারিখ স্ট্রিং হিসেবে সেভ হবে

    day_key TEXT NOT NULL,

    status TEXT NOT NULL DEFAULT 'candidate'
        CHECK (status IN ('candidate', 'published')),

    score INTEGER NOT NULL DEFAULT 0,  -- স্কোর ইন্টিজার

    search_text TEXT  -- সার্চ ফিচারের জন্য প্রয়োজনীয়
);

CREATE INDEX IF NOT EXISTS idx_news_status
ON news(status);

CREATE INDEX IF NOT EXISTS idx_news_day_key
ON news(day_key);

CREATE INDEX IF NOT EXISTS idx_news_published_at
ON news(published_at);

CREATE INDEX IF NOT EXISTS idx_news_score
ON news(score DESC);