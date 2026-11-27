import { createObserveModule } from '@nestjs/observe';

// Do not ship source snippets with errors from this clinical messaging service.
export const { ObserveModule, ObserveInstrument } = createObserveModule({ sourceContext: false });
