import { isolatedSuite } from "./isolated-suite";

isolatedSuite("review behavior with isolated module mocks", new URL("./isolated/review.suite.ts", import.meta.url));
