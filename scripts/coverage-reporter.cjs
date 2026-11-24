'use strict';

// Keep Node's file/line/branch details for inspecting uncovered error paths.
module.exports = async function* coverageReporter(events) {
  for await (const event of events) {
    if (event.type === 'test:coverage') yield `${JSON.stringify(event.data.summary, null, 2)}\n`;
  }
};
