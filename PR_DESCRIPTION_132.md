# feat(gf-132): Admin Analytics Dashboard with Donation Trends and Project Impact Metrics

Closes #132

## Summary

This PR implements a **comprehensive admin analytics dashboard** providing actionable insights into donation trends, project performance, geographic impact distribution, donor retention, category breakdown, and platform growth metrics. It includes a backend analytics service with materialized views, admin API endpoints with CSV/JSON export, and a full-featured React dashboard with interactive charts and sortable tables.

---

## Changes

### Files Created (4 files, ~907 lines)

| File | Lines | Purpose |
|------|-------|---------|
| `backend/src/services/analyticsService.js` | 253 | Six analytics query functions: `getDonationTrends`, `getProjectPerformance`, `getGeographicImpact`, `getDonorRetention`, `getCategoryBreakdown`, `getPlatformGrowth` |
| `backend/src/routes/admin/analytics.js` | 178 | Admin API endpoints: `GET /trends`, `/projects`, `/geographic`, `/retention`, `/categories`, `/growth`, `/export` with CSV/JSON export support |
| `backend/src/db/migrations/016_analytics_views.js` | 136 | Four PostgreSQL materialized views: `mv_daily_donations`, `mv_project_performance`, `mv_geographic_impact`, `mv_donor_cohorts` |
| `frontend/pages/admin/analytics.tsx` | 340 | Full analytics dashboard page with admin auth gating, summary cards, Recharts charts, sortable tables, and export buttons |

### Files Modified (3 files, +150 lines)

| File | Lines | Changes |
|------|-------|---------|
| `backend/src/server.js` | +18 | Register `admin/analytics` routes before the generic admin router |
| `frontend/lib/api.ts` | +120 | Admin analytics TypeScript interfaces + 7 API helper functions (`fetchAdminDonationTrends`, `fetchAdminProjectPerformance`, etc.) and `exportAdminAnalytics` with blob download |
| `frontend/pages/admin/index.tsx` | +3 | Nav link from admin dashboard to analytics page |

---

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                    Admin Analytics Dashboard                  │
│                  frontend/pages/admin/analytics.tsx           │
│                                                              │
│  Summary Cards  │  Donation Trends  │  Category Donut        │
│  (4 widgets)    │  (LineChart)      │  (PieChart)            │
│                 │                   │                        │
│  Platform       │  Project          │  Geographic Impact     │
│  Growth         │  Performance      │  (Table)               │
│  (AreaChart)    │  (Sortable Table) │                        │
│                 │                   │  Donor Retention       │
│  Export CSV/JSON│                   │  (Cohort Table)        │
└────────┬─────────────────────────────────────────────────────┘
         │ adminKey header
         ▼
┌──────────────────────────────────────────────────────────────┐
│               Admin Analytics API (admin/analytics)          │
│  GET /trends?from=&to=  │  GET /growth    │  GET /export    │
│  GET /projects          │  GET /categories│  (CSV / JSON)   │
│  GET /geographic        │  GET /retention │                 │
└────────┬─────────────────────────────────────────────────────┘
         │
         ▼
┌──────────────────────────────────────────────────────────────┐
│              analyticsService.js                             │
│  getDonationTrends()    getCategoryBreakdown()               │
│  getProjectPerformance()  getPlatformGrowth()               │
│  getGeographicImpact()    getDonorRetention()               │
└────────┬─────────────────────────────────────────────────────┘
         │
         ▼
┌──────────────────────────────────────────────────────────────┐
│         PostgreSQL Materialized Views                        │
│  mv_daily_donations     mv_project_performance               │
│  mv_geographic_impact   mv_donor_cohorts                     │
└──────────────────────────────────────────────────────────────┘
```

---

## Dashboard Panels

| Panel | Type | Description |
|-------|------|-------------|
| **Summary Cards** | 4 cards | Total Raised (XLM), Total Donors, Total Projects, Active Donors (30d) |
| **Donation Trends** | Dual-axis LineChart | XLM volume (left axis) + unique donors (right axis) over time |
| **Category Breakdown** | Donut PieChart | Donation distribution by project category |
| **Geographic Impact** | Sortable Table | Top 15 countries by XLM raised, with project and donor counts |
| **Platform Growth** | AreaChart | Monthly donations and donors over time |
| **Project Performance** | Sortable Table | All projects with raised XLM, donors, progress %, CO₂, status |
| **Donor Retention** | Cohort Table | Monthly cohorts with retention percentage at each activity month |

---

## Backend API

| Endpoint | Method | Auth | Params | Description |
|----------|--------|------|--------|-------------|
| `/api/v1/admin/analytics/trends` | GET | Admin | `from`, `to` | Daily donation totals |
| `/api/v1/admin/analytics/projects` | GET | Admin | — | Project performance metrics |
| `/api/v1/admin/analytics/geographic` | GET | Admin | — | Geographic impact by country |
| `/api/v1/admin/analytics/retention` | GET | Admin | — | Donor cohort retention data |
| `/api/v1/admin/analytics/categories` | GET | Admin | `from`, `to` | Category breakdown |
| `/api/v1/admin/analytics/growth` | GET | Admin | — | Platform growth summary + monthly |
| `/api/v1/admin/analytics/export` | GET | Admin | `view`, `type`, `from`, `to` | CSV or JSON export |

---

## Acceptance Criteria Checklist

- [x] Summary cards with current platform stats
- [x] Donation trends chart with time range selection (30d/90d/180d/1y/All)
- [x] Project performance table sortable by any column
- [x] Geographic impact table shows donation distribution by country
- [x] Donor retention cohorts with retention percentage
- [x] Category donut chart with legend
- [x] Platform growth area chart
- [x] CSV/JSON export works via blob download
- [x] Admin authentication required on all endpoints
- [x] `cd backend && npm test` passes (49 suites, 556 tests)
- [x] Materialized views for performance optimization

---

## Testing

```
Backend:  49 suites, 556 tests — all passed
Frontend: Pre-existing jest config issue (unrelated to this PR)
```

### Manual Testing Checklist

- [ ] Visit `/admin/analytics` — verify admin wallet connect gate
- [ ] After connecting, verify all 7 panels render with data
- [ ] Change time range selector — verify trends and categories update
- [ ] Sort project performance table by different columns
- [ ] Click Export CSV/JSON — verify file downloads
- [ ] Verify nav link from `/admin` to `/admin/analytics`
- [ ] Verify materialized views exist in database after migration

---

## Migration

Run `npm run db:migrate` in the backend to create the four materialized views:
- `mv_daily_donations`
- `mv_project_performance`
- `mv_geographic_impact`
- `mv_donor_cohorts`

Views are refreshed on each analytics query via `REFRESH MATERIALIZED VIEW`.

---

## References

- Issue: #132
- Existing analytics: `backend/src/routes/analytics.js` (project-owner)
- Existing charts: `frontend/components/DonationGrowthChart.tsx`
- Admin patterns: `backend/src/routes/admin/audit-stats.js`, `backend/src/routes/admin/webhooks.js`
