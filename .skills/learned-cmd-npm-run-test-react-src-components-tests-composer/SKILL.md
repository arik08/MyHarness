---
name: learned-cmd-npm-run-test-react-src-components-tests-composer
description: >
  Use when a targeted React/Vitest test command appears to fail repeatedly and
  the next useful step is to diagnose the test/component contract, not repeat
  the same command blindly.
---

# learned-cmd-npm-run-test-react-src-components-tests-composer

Automatically learned guidance, generalized from prior targeted React test failures.

## When To Use
- Use for repeated frontend test failures around a specific component or test file.

## Generalized Lesson
- The exact component name in the evidence is not the lesson. The lesson is to inspect the failing assertion, component props/state, and test setup before rerunning the same command.
- A test command printing setup output is not itself the root cause; read the actual failure lines.

## Recommended Next Step
- Run the narrow test, inspect the failing assertion and nearby component code, then make the smallest behavioral or test update that matches the app contract.
- Re-run the same narrow test after the fix.

## Avoid
- Do not create a learned habit of opening the same historical file; use the current failing file from the command output.
