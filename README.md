# @warsam-e/stash
### A simple and flexible caching library for TypeScript

<a href="https://www.npmjs.com/package/@warsam-e/stash"><img src="https://img.shields.io/npm/v/@warsam-e/stash?maxAge=3600" alt="npm version" /></a>
<a href="https://www.npmjs.com/package/@warsam-e/stash"><img src="https://img.shields.io/npm/dt/@warsam-e/stash.svg?maxAge=3600" alt="npm downloads" /></a>

## Installation

```zsh
% bun i @warsam-e/stash
```

## Usage

```typescript
import { Stash } from '@warsam-e/stash';

const stash = new Stash("example-key"); // default driver -> InMemoryDriver

async function orig_data() { ... }
const data = () => stash.wrap("item-key", "1 hour later", () => orig_data())

data().then(console.log);
// after the first, any calls to the same key (with the matching duration)
// will return the cached value
```

## Drivers

- **InMemoryDriver**: The default driver, stores data in memory.
- **RedisDriver**: Stores data in a Redis database.
- **SqliteDriver**: Stores data in a SQLite file.
