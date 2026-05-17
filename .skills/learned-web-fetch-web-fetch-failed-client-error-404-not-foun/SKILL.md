---
name: learned-web-fetch-web-fetch-failed-client-error-404-not-foun
description: >
  Use when a raw GitHub or direct file URL returns 404 and the next step should
  verify repository, branch, and path through a structured listing.
---

# learned-web-fetch-web-fetch-failed-client-error-404-not-foun

Automatically learned guidance, generalized from prior direct-file 404 failures.

## When To Use
- Use for 404s from raw file URLs, guessed repository paths, branch names, or documentation filenames.

## Generalized Lesson
- A raw URL 404 often means the owner, repo, branch, or path is wrong. The durable fix is to list the repository contents or use the hosting API, not to keep guessing adjacent raw URLs.

## Recommended Next Step
- Use the GitHub API, repository tree/listing, or connector/CLI to confirm the current branch and path.
- Then fetch the confirmed file URL.

## Avoid
- Do not assume `main`, a copied org name, or a remembered filename is current.
