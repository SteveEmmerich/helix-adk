---
name: git-workflow
version: 1.0.0
description: Follow conventional commits and branch naming
author: helix-team
license: MIT
allowed-tools: [bash, read_file]
requires_approval: [bash]
network: false
tags: [git, commits, workflow]
min-helix-version: 0.1.0
---

# Git Workflow Skill

Branch naming: feature/description, fix/description, chore/description

Commit format (Conventional Commits):
type(scope): description

Types: feat, fix, docs, style, refactor, test, chore

Always:
- Run tests before committing (bash requires_approval)
- Keep commits atomic and focused
- Reference issue numbers when applicable
