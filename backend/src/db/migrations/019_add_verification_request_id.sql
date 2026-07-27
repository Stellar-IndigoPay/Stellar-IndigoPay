-- Migration to add verification_request_id to projects table
ALTER TABLE projects ADD COLUMN IF NOT EXISTS verification_request_id UUID REFERENCES verification_requests(id);
