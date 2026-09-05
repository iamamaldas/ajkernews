-- ==========================================
-- D1 Database Indexes for Performance
-- ==========================================

-- News sorting & filtering (most important)
CREATE INDEX IF NOT EXISTS idx_news_status_created ON news(status, created_at DESC);

-- Category filtering
CREATE INDEX IF NOT EXISTS idx_news_category ON news(category);

-- Search optimization
CREATE INDEX IF NOT EXISTS idx_news_search_text ON news(search_text);
