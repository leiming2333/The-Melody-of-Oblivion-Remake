export function createFabricApiUi({ minecraft, elements, readableError = (error) => error.message }) {
  const { dialog, target, includeApi, versionSelect, status, retryButton,
    installButton, skipButton, cancelButtons, title, description, includeSetting } = elements;
  let pending;
  let requestToken = 0;
  let versions = [];
  let loading = false;

  function updateChoice() {
    const apiOnly = pending?.apiOnly === true;
    if (apiOnly) includeApi.checked = true;
    const wantsApi = apiOnly || includeApi.checked;
    versionSelect.disabled = loading || !wantsApi || versions.length === 0;
    installButton.disabled = wantsApi
      && (loading || !versions.some((version) => version.id === versionSelect.value));
    installButton.textContent = apiOnly ? '添加 Fabric API' : wantsApi ? '安装 Fabric + API' : '仅安装 Fabric';
  }

  function finish(choice) {
    if (!pending) return;
    const { resolve } = pending;
    pending = undefined;
    requestToken += 1;
    if (dialog.open) dialog.close();
    resolve(choice);
  }

  async function load(force = false) {
    if (!pending) return;
    const current = pending;
    const token = ++requestToken;
    loading = true;
    versions = [];
    versionSelect.replaceChildren();
    retryButton.hidden = true;
    status.dataset.state = 'loading';
    status.textContent = '正在查询兼容的 Fabric API 版本…';
    updateChoice();
    try {
      if (!minecraft?.listFabricApiVersions) throw new Error('当前环境无法查询 Fabric API');
      const result = await minecraft.listFabricApiVersions(current.gameVersion, { force });
      if (pending !== current || token !== requestToken) return;
      if (result?.gameVersion !== current.gameVersion || !Array.isArray(result?.versions)
        || result.versions.some((version) => !version || typeof version.id !== 'string' || !version.id.trim())) {
        throw new Error('Fabric API 版本列表格式无效，请重试');
      }
      versions = [...new Map(result.versions.map((version) => [version.id, version])).values()]
        .sort((left, right) => (Date.parse(right.datePublished) || 0) - (Date.parse(left.datePublished) || 0));
      for (const version of versions) {
        const option = dialog.ownerDocument.createElement('option');
        option.value = version.id;
        const type = { release: '正式版', beta: '测试版', alpha: '开发版' }[version.versionType] ?? '预览版';
        option.textContent = `${version.version || version.name || version.id} · ${type}`;
        versionSelect.append(option);
      }
      const stable = versions.find((version) => version.versionType === 'release');
      versionSelect.value = (stable ?? versions[0])?.id ?? '';
      status.dataset.state = versions.length ? 'ready' : 'empty';
      status.textContent = versions.length
        ? `找到 ${versions.length} 个兼容版本，${stable ? '默认选择最新正式版' : '仅有预览版本，请确认后安装'}。`
        : `没有适用于 Minecraft ${current.gameVersion} 的 Fabric API，${current.apiOnly ? '可重新查询或取消' : '可仅安装 Fabric'}。`;
      retryButton.hidden = versions.length > 0;
    } catch (error) {
      if (pending !== current || token !== requestToken) return;
      status.dataset.state = 'error';
      status.textContent = `Fabric API 查询失败：${readableError(error)}。可重试或${current.apiOnly ? '取消' : '仅安装 Fabric'}。`;
      retryButton.hidden = false;
    } finally {
      if (pending === current && token === requestToken) {
        loading = false;
        updateChoice();
      }
    }
  }

  includeApi.addEventListener('change', updateChoice);
  versionSelect.addEventListener('change', updateChoice);
  retryButton.addEventListener('click', () => { void load(true); });
  installButton.addEventListener('click', () => {
    if (installButton.disabled) return;
    finish({ fabricApiVersionId: pending?.apiOnly || includeApi.checked ? versionSelect.value : null });
  });
  skipButton.addEventListener('click', () => finish(pending?.apiOnly ? null : { fabricApiVersionId: null }));
  for (const button of cancelButtons) button.addEventListener('click', () => finish(null));
  dialog.addEventListener('cancel', (event) => { event.preventDefault(); finish(null); });
  dialog.addEventListener('close', () => { if (!dialog.open) finish(null); });

  function confirm({ gameVersion, loaderVersion, apiOnly = false }) {
    finish(null);
    apiOnly = apiOnly === true;
    includeApi.checked = true;
    includeApi.disabled = apiOnly;
    if (includeSetting) includeSetting.hidden = apiOnly;
    skipButton.hidden = apiOnly;
    if (title) title.textContent = apiOnly ? '添加 Fabric API' : '同时安装 Fabric API？';
    if (description) description.textContent = apiOnly
      ? '为已安装的 Fabric 添加兼容的 Fabric API，选择版本后安装到该游戏的 Mod 目录。'
      : '许多 Fabric 模组需要 Fabric API，可一起安装，也可稍后添加。';
    target.textContent = `Minecraft ${gameVersion} · Fabric ${loaderVersion}`;
    const answer = new Promise((resolve) => { pending = { resolve, gameVersion, apiOnly }; });
    try { dialog.showModal(); }
    catch (error) { finish(null); throw error; }
    void load();
    return answer;
  }

  return { confirm, cancel: () => finish(null) };
}
