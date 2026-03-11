# RefIQ — AI Referee Training Platform

## Stack
- **Netlify** — hosting + serverless function (API proxy)
- **Firebase** — Auth + Firestore database
- **Anthropic Haiku** — AI question generation

## Setup

### 1. Netlify Environment Variable
Add `ANTHROPIC_API_KEY` in Netlify → Site configuration → Environment variables

### 2. Firebase Setup
- Enable **Authentication** (Email/Password + Google)
- Enable **Firestore** (test mode to start)

### 3. Deploy
Push to GitHub → Netlify auto-deploys

## Features
- **Public quiz** — IFAB 2025/26 + drag & drop league rules
- **League quiz links** — `/q/[slug]` with branding baked in
- **Admin dashboard** — `/admin` — manage resources, links, view results
- **Score tracking** — referee names + pass/fail saved to Firestore
- **CSV export** — download all results

## Firestore Structure
```
/leagues/{uid}           — league profile + branding
/leagues/{uid}/resources — uploaded rule documents
/quiz_links/{id}         — shareable quiz configurations
/quiz_results/{id}       — referee scores
```
