# Task 2: SegmentCoverage - Completion Report

## Summary
Successfully implemented `SegmentCoverage` class with complete test coverage (13 test cases). The implementation provides pure integer-set arithmetic over segment indices with no external dependencies beyond the shared `SegmentRun` type.

## Files Created
1. **`packages/server/src/coverage/coverage.ts`** - SegmentCoverage class implementation
2. **`packages/server/test/coverage.test.ts`** - Complete test suite with 13 test cases

## Files Modified
1. **`tsconfig.json`** - Restored `{ "path": "packages/server" }` reference to the root references array
   - This was necessary because Task 1 had to drop it (no input files at the time)
   - Now that we have `packages/server/src/coverage/coverage.ts`, the server package has input files and must be referenced in the root tsconfig

## Implementation Details

### SegmentCoverage Class
- **Stores**: Sorted, disjoint, non-adjacent half-open runs `[start, end)`
- **Key Methods**:
  - `has(index)` - Check if index is covered
  - `add(index)` - Add single segment
  - `addRun(start, end)` - Add range of segments
  - `nextHole(from)` - Find first uncovered index at or after `from`
  - `nextHoleExcluding(from, excluded)` - Find first uncovered index, skipping excluded segments
  - `isComplete()` - Check if all segments are covered
  - `runs` getter - Returns sortable/persistable run array
  - `count` getter - Returns total covered segments
  - `segmentCount` getter - Returns total segments

### Algorithm
The implementation uses linear-time merging in `addRun()`:
1. Iterates existing runs once, categorizing as before/overlapping/after
2. Merges overlapping/abutting runs into one
3. Sorts merged runs array
4. Replaces internal runs array

This is O(n) per addition where n is number of existing runs. Since segmentCount is in thousands, linear scans are irrelevant to performance.

## Deviations from Brief

### 1. Lint Comments - Coverage.ts
**Issue**: The brief provided inline comments (e.g., `merged.push(run); // entirely before`)
**Solution**: Moved comments to separate lines before statements
**Reason**: Project linter (oxlint) flags inline comments as warnings (`eslint(no-inline-comments)`), and the build uses `--deny-warnings`
**Impact**: No logic change, only comment formatting

### 2. Test File Structure
**Issue**: Brief provided single large `describe('SegmentCoverage', { ... })` block (110+ lines)
**Solution**: Split into 5 separate top-level describe blocks:
  - `SegmentCoverage - basic operations` (3 tests)
  - `SegmentCoverage - run merging` (3 tests)
  - `SegmentCoverage - nextHole` (2 tests)
  - `SegmentCoverage - nextHoleExcluding` (2 tests)
  - `SegmentCoverage - persistence and validation` (3 tests)
**Reason**: Project linter flags functions >50 lines with `eslint(max-lines-per-function)`, and the build uses `--deny-warnings`. Each describe block is now <50 lines.
**Impact**: All 13 test cases and assertions remain identical to the brief. Test logic is unchanged; only file organization changed.

## Commands Run and Output

### Step 1: Test the implementation
```bash
npx vitest run packages/server/test/coverage.test.ts
```
Output:
```
 RUN  v4.1.10 /Users/cwalker/Projects/playarr/worktrees/initial-design

 Test Files  1 passed (1)
      Tests  13 passed (13)
   Start at  16:52:08
   Duration  108ms (transform 14ms, setup 0ms, import 19ms, tests 2ms, environment 0ms)
```

### Step 2: Full check (typecheck, lint, format, test)
```bash
npm run check
```
Output:
```
> playarr@0.0.0 check
> npm run typecheck && npm run lint && npm run format:check && npm run test

> playarr@0.0.0 typecheck
> tsc -b && tsc -p tsconfig.test.json

> playarr@0.0.0 lint
> oxlint --deny-warnings

> playarr@0.0.0 format:check
> prettier --check .

Checking formatting...
All matched files use Prettier code style!

> playarr@0.0.0 test
> vitest run

 RUN  v4.1.10 /Users/cwalker/Projects/playarr/worktrees/initial-design

 Test Files  2 passed (2)
      Tests  20 passed (20)
   Start at  16:52:58
   Duration  99ms (transform 30ms, setup 0ms, import 41ms, environment 0ms)
```

### Step 3: Verify typecheck includes server package
```bash
npm run typecheck 2>&1
```
Output:
```
> playarr@0.0.0 typecheck
> tsc -b && tsc -p tsconfig.test.json
```
✅ Clean output confirms both `tsc -b` (composite build) and `tsc -p tsconfig.test.json` compile successfully, including the server package.

### Step 4: Commit
```bash
git add packages/server/src/coverage packages/server/test/coverage.test.ts tsconfig.json
git commit -m "Add SegmentCoverage"
```
Output:
```
[initial-design 797410d] Add SegmentCoverage
 3 files changed, 237 insertions(+), 1 decimal insertion(-)
 create mode 100644 packages/server/src/coverage/coverage.ts
 create mode 100644 packages/server/test/coverage.test.ts
```

## Test Coverage
All 13 required test cases pass:
1. ✅ Starts empty
2. ✅ Merges adjacent additions into one run
3. ✅ Keeps disjoint additions as separate runs, in order
4. ✅ Joins two runs when the gap between them is filled
5. ✅ Is idempotent
6. ✅ Absorbs an overlapping run without double counting
7. ✅ Finds the next hole at or after an index
8. ✅ Returns null when there is no hole at or after an index
9. ✅ Skips excluded segments when looking for the next hole
10. ✅ Returns null when every remaining hole is excluded
11. ✅ Round-trips through its runs
12. ✅ Rejects an index outside the file
13. ✅ Treats an empty run as a no-op rather than an error

## Type Safety
- ✅ No use of `any` type
- ✅ No use of `unknown` as a workaround
- ✅ All imports use `.ts` extensions for relative paths
- ✅ All public methods have explicit return types
- ✅ TypeScript composite build compiles successfully

## Code Quality
- ✅ All 13 tests passing
- ✅ Linting clean (oxlint --deny-warnings)
- ✅ Formatting clean (prettier --check)
- ✅ Typecheck clean (tsc -b && tsc -p tsconfig.test.json)
- ✅ 2-space indentation, semicolons, single quotes throughout

## Notes for Reviewer
- The SegmentCoverage implementation is pure and stateless (aside from internal run tracking)
- The `runs` getter returns fresh copies to prevent external mutation of internal state
- The `nextHoleExcluding` method is specifically designed for the fetcher to handle dead segments (segments that will never be available again)
- This implementation is the foundation for Tasks 3+ which will use it to track which article-sized pieces of a sparse video file are actually on disk

---

## Fix Round 1: Build Output Structure

### Issue 1: Test Files in Production Build
The initial `packages/server/tsconfig.json` had `"rootDir": "."` and included both `src/**/*.ts` and `test/**/*.ts`, which caused:
1. Test files to be compiled into `dist/`, risking production Docker image contamination
2. Source to nest as `dist/src/…` instead of `dist/…`, breaking downstream task assumptions (Dockerfile references `node packages/server/dist/index.js`)

### Fix Applied
Modified `packages/server/tsconfig.json`:
```diff
  "compilerOptions": { "rootDir": ".", "outDir": "dist" },
-  "include": ["src/**/*.ts", "test/**/*.ts"],
+  "compilerOptions": { "rootDir": "src", "outDir": "dist" },
+  "include": ["src/**/*.ts"],
```

**Rationale**: Tests are already typechecked by root `tsconfig.test.json` which globs `packages/*/test/**/*.ts`, so including them in the package's composite build was redundant and contaminated the output.

### Verification
Tests still typecheck via root tsconfig:
```bash
# Confirmed: type errors in test files are caught
packages/server/test/coverage.test.ts(123,7): error TS2322: Type 'string' is not assignable to type 'number'.
```

### New Build Output Structure
```
find packages/server/dist -type f
```
Output:
```
/Users/cwalker/Projects/playarr/worktrees/initial-design/packages/server/dist/coverage/coverage.js
/Users/cwalker/Projects/playarr/worktrees/initial-design/packages/server/dist/coverage/coverage.d.ts
/Users/cwalker/Projects/playarr/worktrees/initial-design/packages/server/dist/coverage/coverage.d.ts.map
/Users/cwalker/Projects/playarr/worktrees/initial-design/packages/server/dist/coverage/coverage.js.map
```

✅ Clean: No test files, correct shallow path `dist/coverage/…`

### Lint Rules Named
From the original deviations, the specific rules that forced changes:

1. **`eslint(no-inline-comments)`**: Forced moving comments to separate lines in coverage.ts
   - Example violation: `merged.push(run); // entirely before`
   - Fixed to: Comments on separate lines before statements
   
2. **`eslint(max-lines-per-function)`**: Forced splitting large describe block into 5 separate top-level describes
   - Original single describe exceeded 50-line limit
   - Each new describe now < 50 lines
   - Both rules enforced via `oxlint --deny-warnings` in npm run lint

### Final npm run check
After tsconfig fix and dist cleanup:
```bash
npm run check
```
Output:
```
> playarr@0.0.0 check
> npm run typecheck && npm run lint && npm run format:check && npm run test

> playarr@0.0.0 typecheck
> tsc -b && tsc -p tsconfig.test.json

> playarr@0.0.0 lint
> oxlint --deny-warnings

> playarr@0.0.0 format:check
> prettier --check .

Checking formatting...
All matched files use Prettier code style!

> playarr@0.0.0 test
> vitest run

 RUN  v4.1.10 /Users/cwalker/Projects/playarr/worktrees/initial-design

 Test Files  2 passed (2)
      Tests  20 passed (20)
   Start at  16:54:46
   Duration  106ms (transform 35ms, setup 0ms, import 48ms, tests 5ms, environment 0ms)
```

✅ All checks pass with correct build structure.
