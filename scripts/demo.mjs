const { runDemo } = await import('../packages/test-support/lib/demo.js');

const demo = await runDemo();
for (const event of demo.executionEvents) console.log(`观测：${event}`);
console.log(`回复：${demo.response}`);
console.log(`工具调用：${JSON.stringify(demo.toolInput)}`);
console.log(`会话事实：${demo.eventTypes.join(' → ')}`);
