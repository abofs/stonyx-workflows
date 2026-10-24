# Green: correct imports

```js
import Command from '@stonyx/discord/command';
import Discord, { version } from '@stonyx/discord';
```

~~~typescript
import Bot, { type ClearChannelMessagesResult } from '@stonyx/discord/bot';
import type { ClearChannelMessagesResult as Result } from '@stonyx/discord/bot';
~~~

1. Indented inside a list item, untagged, multi-line, re-exported:

   ```
   import {
     version as discordVersion,
   } from '@stonyx/discord';
   export { default as Command } from '@stonyx/discord/command';
   export * from '@stonyx/discord/bot';
   ```

```mjs
import Button from "@stonyx/discord/widgets/button"; import '@stonyx/discord/command';
```

Prose is out of scope: `import { Nope } from '@stonyx/discord'`.

```js
const later = await import('@stonyx/discord/not-checked'); // dynamic import is out of scope
```
