import { isolatedSuite } from "./isolated-suite";
isolatedSuite("team snapshot read integration", new URL("./isolated/shared-context.suite.ts", import.meta.url));
