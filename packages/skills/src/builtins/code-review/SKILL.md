---
name: code-review
version: 1.0.0
description: Review code for bugs, security issues, and style
author: helix-team
license: MIT
allowed-tools: [read_file, list_directory]
requires_approval: []
network: false
tags: [code, review, quality]
min-helix-version: 0.1.0
---

# Code Review Skill

When asked to review code:
1. Read the relevant files using read_file
2. Check for: bugs, security vulnerabilities, style issues, missing error handling, performance concerns
3. Structure your review with sections: Summary, Issues Found, Suggestions, Overall Assessment
4. Be specific — reference file names and line numbers
5. Distinguish between blocking issues and suggestions
