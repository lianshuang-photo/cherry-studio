---
title: Agent environment variables reject null bytes
category: changed
severity: notice
introduced_in_pr: '#30'
date: '2026-09-17'
---

## What changed

Saving Agent settings now rejects environment variable names or values containing null bytes (U+0000). The validation error does not display variable values.

## Why this matters to the user

Invalid environment variables are reported when saving instead of causing a later process startup error. Existing stored configurations containing null bytes have their environment-variable field omitted by the configuration read sanitizer.

## What the user should do

Remove null bytes and save the affected environment variables again. Valid configurations require no action.

## Notes for release manager

This change only checks U+0000; it does not address every possible platform-specific process startup error.
