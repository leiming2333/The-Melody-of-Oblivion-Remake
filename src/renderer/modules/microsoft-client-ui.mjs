export function microsoftConfigurationMessage(configuration) {
  const source = { bundled: '内置', custom: '自定义', environment: '环境变量指定的' }[configuration?.source] ?? '当前';
  return `正在使用${source} Client ID；Minecraft Services 审核状态未确认。`;
}

export function renderMicrosoftClientConfiguration(elements, configuration) {
  const message = microsoftConfigurationMessage(configuration);
  for (const element of elements.statuses) {
    element.textContent = message;
    element.title = configuration?.clientId ?? '';
  }
  elements.input.disabled = configuration?.source === 'environment';
  elements.input.placeholder = configuration?.source === 'environment'
    ? '由 MELODY_MICROSOFT_CLIENT_ID 覆盖'
    : '留空使用启动器内置 ID';
  elements.input.title = configuration?.source === 'environment'
    ? '环境变量优先；取消环境变量后可编辑自定义 ID。'
    : '仅影响保存后发起的新登录，已保存账户继续使用原授权 ID。';
}
