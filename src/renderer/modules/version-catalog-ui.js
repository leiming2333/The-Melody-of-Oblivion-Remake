(function exposeUiModules(root) {
  function createVersionCatalogUi(context) {
    let onlineCatalogError;
    let installationActive = false;
    const { state, document, minecraft, delay, fallbackLocalVersionResult, fallbackLoaderResult, fallbackVersionResult,
      loaderNames, versionSelect, versionCatalog, loaderTypeSelect, loaderVersionSelect, versionSearch, versionTypeFilter,
      versionEmpty, refreshVersionsButton, downloadVersionButton, deleteVersionButton, clearVersionSelectionButton,
      gameStatus, statusBadge, activeGameProfiles, rememberedSelectedGame, rememberSelectedGame, gameProcessKey,
      updateLaunchButtonState, refreshJavaReadiness, versionTypeName, readableError, showToast, cancelFabricApiConfirmation } = context;
    function selectedRemoteVersion() {
      if (context.selectRemoteVersion) return context.selectRemoteVersion();
      if (!versionCatalog.selectedOptions[0] || versionCatalog.selectedOptions[0].disabled) {
        return undefined;
      }
      return state.remoteVersions.find((version) => version.id === versionCatalog.value);
    }

    function renderLocalProfileOptions() {
      const preserveStatus = state.versionDownloadActive || state.launchRequestActive || state.javaFixActive;
      const previousStatus = { message: gameStatus.textContent, badge: statusBadge.textContent };
      const previousProfileId = versionSelect.value;
      const installedProfiles = state.localProfiles.filter((profile) => profile.valid);
      versionSelect.replaceChildren();
      const placeholder = document.createElement('option');
      placeholder.value = '';
      placeholder.textContent = installedProfiles.length > 0 ? '请选择已安装游戏' : '未发现已安装游戏';
      placeholder.disabled = installedProfiles.length > 0;
      placeholder.hidden = installedProfiles.length > 0;
      versionSelect.append(placeholder);

      for (const profile of installedProfiles) {
        const option = document.createElement('option');
        option.value = profile.targetId ?? profile.profileId;
        const loaderLabel = loaderNames[profile.loaderType] ?? '自定义';
        const displayName = profile.displayName ?? profile.profileId;
        option.textContent = profile.loaderType === 'vanilla'
          ? displayName
          : `${displayName} · ${loaderLabel}`;
        if (!profile.complete) option.textContent += ' · 待验证或修复';
        versionSelect.append(option);
      }

      const preferredProfileId = previousProfileId || rememberedSelectedGame();
      const preferredOption = preferredProfileId
        ? [...versionSelect.options].find((option) => option.value === preferredProfileId && !option.disabled)
        : undefined;
      const selectedOption = preferredOption
        ?? [...versionSelect.options].find((option) => option.value && !option.disabled);
      versionSelect.value = selectedOption?.value ?? '';
      rememberSelectedGame(versionSelect.value);
      if (selectedOption) {
        const selectedProfile = installedProfiles.find((profile) => (
          (profile.targetId ?? profile.profileId) === selectedOption.value
        ));
        gameStatus.textContent = `已选择 ${selectedProfile?.displayName ?? selectedProfile?.profileId ?? selectedOption.value}`;
        statusBadge.textContent = activeGameProfiles.has(gameProcessKey(selectedOption.value)) ? 'RUNNING' : 'SELECTED';
      } else {
        gameStatus.textContent = installedProfiles.length > 0 ? '请选择游戏版本' : '尚无已安装游戏，可在「切换版本」中下载';
        statusBadge.textContent = 'READY';
      }
      if (preserveStatus) {
        gameStatus.textContent = previousStatus.message;
        statusBadge.textContent = previousStatus.badge;
      }
      updateLaunchButtonState();
      updateVersionAction();
      refreshJavaReadiness();
    }

    async function loadLocalProfiles(force = false) {
      if (state.localProfilesLoadingPromise) return state.localProfilesLoadingPromise;
      if (state.localProfilesLoaded && !force) return state.localProfiles;

      const requestToken = ++state.localProfilesLoadToken;
      const request = context.beginRequest?.('local-profiles');
      const pending = (async () => {
        const result = minecraft?.listLocalVersions
          ? await minecraft.listLocalVersions()
          : await delay(80).then(fallbackLocalVersionResult);
        if (requestToken !== state.localProfilesLoadToken || request?.signal.aborted) return state.localProfiles;
        state.localProfiles = result.profiles ?? [];
        state.currentGameDirectory = result.gameDirectory ?? state.currentGameDirectory;
        state.localProfilesLoaded = true;
        context.renderProfiles();
        return state.localProfiles;
      })();
      state.localProfilesLoadingPromise = pending;
      try {
        return await pending;
      } catch (error) {
        if (requestToken !== state.localProfilesLoadToken) return state.localProfiles;
        throw error;
      } finally {
        request?.finish();
        if (state.localProfilesLoadingPromise === pending) {
          state.localProfilesLoadingPromise = undefined;
          versionSelect.classList.remove('startup-placeholder');
          versionSelect.setAttribute('aria-busy', 'false');
        }
      }
    }

    function localBaseProfiles() {
      return state.localProfiles.filter((profile) => profile.valid && !profile.inheritsFrom && !profile.isInstance);
    }

    function seedCatalogWithLocalProfiles() {
      state.remoteVersions = localBaseProfiles().map((profile) => ({
        id: profile.profileId,
        type: profile.type,
        releaseTime: profile.releaseTime,
        installed: profile.complete,
        complete: profile.complete,
        localFilesPresent: true,
        localOnly: true,
        profileId: profile.profileId
      }));
    }

    function mergeRemoteAndLocalVersions(onlineVersions) {
      const localById = new Map(localBaseProfiles().map((profile) => [profile.profileId, profile]));
      const onlineIds = new Set(onlineVersions.map((version) => version.id));
      const merged = onlineVersions.map((version) => {
        const local = localById.get(version.id);
        return local ? {
          ...version,
          installed: version.installed || local.complete,
          complete: local.complete,
          localFilesPresent: true,
          profileId: local.profileId
        } : version;
      });
      for (const local of localBaseProfiles()) {
        if (onlineIds.has(local.profileId)) continue;
        merged.push({
          id: local.profileId,
          type: local.type,
          releaseTime: local.releaseTime,
          installed: local.complete,
          complete: local.complete,
          localFilesPresent: true,
          localOnly: true,
          profileId: local.profileId
        });
      }
      return merged;
    }

    function selectedLoaderVersion() {
      return state.loaderVersions.find((loader) => loader.version === loaderVersionSelect.value);
    }

    function localLoaderVersions(gameVersion, loaderType) {
      if (!gameVersion) return [];
      if (loaderType === 'vanilla') return [{
        version: gameVersion.id,
        stable: true,
        installed: gameVersion.installed,
        profileId: gameVersion.installed ? gameVersion.id : undefined
      }];

      const byId = new Map(state.localProfiles.filter((profile) => !profile.isInstance)
        .map((profile) => [profile.profileId, profile]));
      function inheritsGame(profile) {
        const visited = new Set();
        while (profile?.inheritsFrom && !visited.has(profile.profileId)) {
          if (profile.inheritsFrom === gameVersion.id) return true;
          visited.add(profile.profileId);
          profile = byId.get(profile.inheritsFrom);
        }
        return false;
      }
      return [...byId.values()]
        .filter((profile) => profile.valid && profile.complete
          && profile.loaderType === loaderType && inheritsGame(profile))
        .map((profile) => ({ version: profile.profileId, installed: true, profileId: profile.profileId, localOnly: true }));
    }

    function seedLoaderCatalogWithLocalProfiles() {
      state.loaderLoadToken += 1;
      state.loaderCatalogLoading = false;
      state.loaderVersions = localLoaderVersions(selectedRemoteVersion(), loaderTypeSelect.value);
      renderLoaderCatalog();
    }

    function renderLoaderCatalog(preferredVersion) {
      const previousVersion = preferredVersion ?? loaderVersionSelect.value;
      loaderVersionSelect.replaceChildren();

      const groups = [
        { label: '已安装', loaders: state.loaderVersions.filter((loader) => loader.installed) },
        { label: '可安装', loaders: state.loaderVersions.filter((loader) => !loader.installed) }
      ];
      for (const group of groups) {
        if (group.loaders.length === 0) continue;
        const optionGroup = document.createElement('optgroup');
        optionGroup.label = `${group.label}（${group.loaders.length}）`;
        for (const loader of group.loaders) {
          const option = document.createElement('option');
          option.value = loader.version;
          option.textContent = loader.version;
          optionGroup.append(option);
        }
        loaderVersionSelect.append(optionGroup);
      }

      const previousOption = [...loaderVersionSelect.options]
        .find((option) => option.value === previousVersion);
      if (previousOption) {
        previousOption.selected = true;
      } else if (loaderVersionSelect.options.length > 0) {
        loaderVersionSelect.selectedIndex = 0;
      } else {
        const emptyOption = document.createElement('option');
        emptyOption.value = '';
        emptyOption.textContent = '该版本暂无可用加载器';
        loaderVersionSelect.append(emptyOption);
      }

      updateVersionAction();
    }

    async function loadLoaderCatalog(force = false) {
      if (state.versionDownloadActive) return;
      const gameVersion = selectedRemoteVersion();
      const loaderType = loaderTypeSelect.value;
      const requestToken = ++state.loaderLoadToken;
      const request = context.beginRequest?.('loaders');
      const localLoaders = localLoaderVersions(gameVersion, loaderType);
      state.loaderVersions = localLoaders;
      state.loaderCatalogLoading = false;

      if (!gameVersion) {
        request?.finish();
        renderLoaderCatalog();
        return;
      }

      if (loaderType === 'vanilla') {
        request?.finish();
        renderLoaderCatalog(gameVersion.id);
        return;
      }

      state.loaderCatalogLoading = true;
      if (!localLoaders.length) {
        loaderVersionSelect.disabled = true;
        loaderVersionSelect.replaceChildren();
        const loadingOption = document.createElement('option');
        loadingOption.textContent = `正在获取 ${loaderNames[loaderType]} 版本…`;
        loaderVersionSelect.append(loadingOption);
      } else {
        renderLoaderCatalog();
      }
      updateVersionAction();

      try {
        const result = minecraft?.listLoaders
          ? await minecraft.listLoaders(gameVersion.id, loaderType, { force })
          : await delay(180).then(() => fallbackLoaderResult(gameVersion.id, loaderType));
        if (requestToken !== state.loaderLoadToken || request?.signal.aborted) return;
        const onlineProfileIds = new Set(result.versions.map((loader) => loader.profileId));
        state.loaderVersions = [...result.versions,
          ...localLoaders.filter((loader) => !onlineProfileIds.has(loader.profileId))];
        renderLoaderCatalog();
        if (state.loaderVersions.length === 0) {
          versionEmpty.textContent = `${loaderNames[loaderType]} 暂不支持 Minecraft ${gameVersion.id}`;
        }
      } catch (error) {
        if (requestToken !== state.loaderLoadToken) return;
        const message = readableError(error);
        state.loaderVersions = localLoaders;
        renderLoaderCatalog();
        const catalogHint = onlineCatalogError ? `；在线版本加载失败：${readableError(onlineCatalogError)}` : '';
        versionEmpty.textContent = `${loaderNames[loaderType]} 获取失败：${message}${catalogHint}`;
        showToast(message);
      } finally {
        request?.finish();
        if (requestToken === state.loaderLoadToken) {
          state.loaderCatalogLoading = false;
          updateVersionAction();
        }
      }
    }

    function updateVersionAction() {
      if (state.versionDownloadActive && !installationActive) {
        // Requests begun before installation describe the old disk state. Their
        // results must stay stale even if they arrive after installation ends.
        state.versionCatalogLoadToken += 1;
        state.loaderLoadToken += 1;
        state.localProfilesLoadToken = (state.localProfilesLoadToken ?? 0) + 1;
        state.localProfilesLoadingPromise = undefined;
        state.localProfilesLoaded = false;
        versionSelect.classList?.remove('startup-placeholder');
        versionSelect.setAttribute?.('aria-busy', 'false');
        state.versionCatalogLoading = false;
        state.loaderCatalogLoading = false;
        context.cancelRequest?.('versions');
        context.cancelRequest?.('loaders');
        context.cancelRequest?.('local-profiles');
      }
      installationActive = Boolean(state.versionDownloadActive);
      const version = selectedRemoteVersion();
      const loaderType = loaderTypeSelect.value;
      const loader = selectedLoaderVersion();
      const busy = Boolean(state.versionDownloadActive || state.fabricApiConfirmationActive || state.versionDeleteActive || state.versionVerifyActive);
      const localOnlyUnavailable = Boolean(version?.localOnly && loaderType === 'vanilla' && !loader?.installed);
      if (refreshVersionsButton) refreshVersionsButton.disabled = busy || Boolean(state.versionCatalogLoading);
      loaderTypeSelect.disabled = !version || busy;
      loaderVersionSelect.disabled = !version || busy || loaderType === 'vanilla' || !state.loaderVersions.length;
      downloadVersionButton.disabled = !version || !loader || busy || localOnlyUnavailable;
      if (context.addFabricApiButton) {
        context.addFabricApiButton.hidden = loaderType !== 'fabric';
        context.addFabricApiButton.disabled = !version || !loader || busy;
        context.addFabricApiButton.textContent = loader?.installed ? '添加 Fabric API' : '选择 Fabric API';
      }
      deleteVersionButton.disabled = !loader?.installed || busy;
      clearVersionSelectionButton.disabled = !versionSelect.value || busy || state.launchRequestActive;
      if (context.versionSelectionSummary) {
        let summary = '选择一个 Minecraft 版本，查看安装选项';
        if (version) {
          const target = loaderType === 'vanilla' ? '原版'
            : `${loaderNames[loaderType] ?? loaderType}${loader ? ` ${loader.version}` : ''}`;
          const availability = state.versionDownloadActive ? '正在安装'
            : state.fabricApiConfirmationActive ? '等待安装确认'
              : !loader ? (state.loaderCatalogLoading ? '正在获取加载器版本' : '暂无可用加载器')
                : loader.installed ? '已安装，可直接使用'
                  : localOnlyUnavailable ? '仅本地，可选择已安装加载器'
                  : version.localFilesPresent && version.complete === false && loaderType === 'vanilla'
                    ? '文件不完整，安装时补齐' : '待安装';
          summary = `Minecraft ${version.id} · ${target} · ${availability}`;
        }
        context.versionSelectionSummary.textContent = summary;
      }
      if (!version) {
        downloadVersionButton.textContent = '选择版本';
        return;
      }
      if (!loader) {
        downloadVersionButton.textContent = state.loaderCatalogLoading ? '正在获取加载器' : '暂无可用版本';
        return;
      }
      if (state.fabricApiConfirmationActive) {
        downloadVersionButton.textContent = '等待安装确认';
        return;
      }
      if (state.versionDownloadActive) {
        downloadVersionButton.textContent = '正在安装';
        return;
      }
      if (localOnlyUnavailable) {
        downloadVersionButton.textContent = '请选择已安装加载器';
        return;
      }
      if (loader.installed) {
        downloadVersionButton.textContent = '使用此版本';
        return;
      }
      if (state.lastDownloadFailed) {
        downloadVersionButton.textContent = '重试';
        return;
      }
      downloadVersionButton.textContent = loaderType === 'vanilla'
        ? (version.localFilesPresent && version.complete === false ? '补齐游戏文件' : '下载原版')
        : `安装 ${loaderNames[loaderType]}`;
    }

    function renderVersionCatalog(preferredId) {
      const query = versionSearch.value.trim().toLowerCase();
      const type = versionTypeFilter.value;
      const previousId = preferredId ?? versionCatalog.value;
      const localProfiles = new Map(state.localProfiles.filter((profile) => profile.valid && !profile.isInstance)
        .map((profile) => [profile.profileId, profile]));
      const installedBaseIds = new Set();
      for (const profile of localProfiles.values()) {
        if (!profile.complete) continue;
        const visited = new Set();
        let current = profile;
        while (current && !visited.has(current.profileId)) {
          visited.add(current.profileId);
          installedBaseIds.add(current.profileId);
          if (current.inheritsFrom) installedBaseIds.add(current.inheritsFrom);
          current = localProfiles.get(current.inheritsFrom);
        }
      }
      const latest = {};
      for (const version of state.remoteVersions) {
        if (version.localOnly || !['release', 'snapshot'].includes(version.type)) continue;
        const previous = latest[version.type];
        const releasedAt = Date.parse(version.releaseTime);
        const previousReleasedAt = Date.parse(previous?.releaseTime);
        if (!previous || (Number.isFinite(releasedAt) && (!Number.isFinite(previousReleasedAt) || releasedAt > previousReleasedAt))) {
          latest[version.type] = version;
        }
      }
      function searchRank(version) {
        const id = version.id.toLowerCase();
        if (id === query) return 0;
        if (id.startsWith(`${query}.`) || id.startsWith(`${query}-`)) return 1;
        return id.startsWith(query) ? 2 : 3;
      }

      state.filteredVersions = state.remoteVersions.filter((version) => {
        const typeMatches = type === 'all' || version.type === type
          || (type === 'old' && ['old_beta', 'old_alpha'].includes(version.type))
          || (type === 'installed' && (version.installed || installedBaseIds.has(version.id)));
        const queryMatches = !query || version.id.toLowerCase().includes(query);
        return typeMatches && queryMatches;
      });
      if (query) state.filteredVersions.sort((a, b) => searchRank(a) - searchRank(b));

      const installedVersions = state.filteredVersions.filter((version) => version.installed);
      const repairVersions = state.filteredVersions.filter((version) => !version.installed && version.localFilesPresent);
      const availableVersions = state.filteredVersions.filter((version) => !version.installed && !version.localFilesPresent);

      versionCatalog.replaceChildren();
      const groups = query ? [{ label: '搜索结果', versions: state.filteredVersions }] : [
        { label: '已安装', versions: installedVersions },
        { label: '待修复', versions: repairVersions },
        { label: '可下载', versions: availableVersions }
      ];
      for (const group of groups) {
        if (!group.versions.length) continue;
        const optionGroup = document.createElement('optgroup');
        optionGroup.label = `${group.label}（${group.versions.length}）`;
        for (const version of group.versions) {
          const option = document.createElement('option');
          option.value = version.id;
          const details = [versionTypeName(version.type)];
          if (latest.release?.id === version.id) details.push('最新正式版');
          if (latest.snapshot?.id === version.id) details.push('最新快照');
          if (version.installed) details.push('已安装');
          else if (installedBaseIds.has(version.id)) details.push('已装加载器');
          else if (version.localFilesPresent) details.push('待修复');
          if (version.localOnly) details.push('仅本地');
          option.textContent = `${version.id}  ·  ${details.join(' · ')}`;
          option.disabled = version.localOnly === true && !version.installed && !installedBaseIds.has(version.id);
          optionGroup.append(option);
        }
        versionCatalog.append(optionGroup);
      }

      const preferredOption = [...versionCatalog.options]
        .find((option) => option.value === previousId && !option.disabled);
      if (preferredOption) {
        preferredOption.selected = true;
      } else {
        const firstEnabledOption = [...versionCatalog.options].find((option) => !option.disabled);
        versionCatalog.selectedIndex = firstEnabledOption ? firstEnabledOption.index : -1;
      }

      versionEmpty.textContent = state.filteredVersions.length
        ? `${state.filteredVersions.length} 个版本 · ${installedVersions.length} 个原版已安装${repairVersions.length ? ` · ${repairVersions.length} 个待修复` : ''}`
        : query ? `没有找到“${versionSearch.value.trim()}”，可更换关键词或筛选条件`
          : type === 'installed' ? '当前目录没有已安装版本，可切换到正式版下载' : '没有符合条件的版本';
      updateVersionAction();
    }

    function invalidateVersionCatalogForDirectoryChange() {
      for (const key of ['local-profiles', 'loaders', 'versions']) context.cancelRequest?.(key);
      onlineCatalogError = undefined;
      cancelFabricApiConfirmation();
      // 安装状态只对当前游戏目录有效。切换目录后不能继续复用上一个目录的
      // 版本和加载器状态，否则旧目录中的版本会被错误显示为“已安装”。
      state.loaderLoadToken += 1;
      state.loaderCatalogLoading = false;
      state.versionCatalogLoadToken += 1;
      state.versionCatalogLoading = false;
      refreshVersionsButton.disabled = false;
      state.localProfilesLoadToken += 1;
      state.localProfilesLoadingPromise = undefined;
      state.localProfilesLoaded = false;
      state.localProfiles = [];
      state.currentGameDirectory = '';
      versionSelect.replaceChildren();
      const pendingOption = document.createElement('option');
      pendingOption.value = '';
      pendingOption.textContent = '正在读取新目录中的游戏…';
      versionSelect.append(pendingOption);
      versionSelect.value = '';
      state.remoteVersions = [];
      state.filteredVersions = [];
      state.loaderVersions = [];
      state.versionCatalogLoaded = false;
      versionCatalog.replaceChildren();
      loaderVersionSelect.replaceChildren();
      versionEmpty.textContent = '游戏目录已切换，打开版本列表时将重新检查已安装版本';
      updateLaunchButtonState();
      refreshJavaReadiness();
      updateVersionAction();
    }

    async function reloadLocalProfilesForDirectoryChange() {
      // Start the new directory independently; a slow old scan must not hold it up
      // or replace the new directory's results when it eventually completes.
      state.localProfilesLoadToken += 1;
      state.localProfilesLoadingPromise = undefined;
      state.localProfilesLoaded = false;
      return loadLocalProfiles(true);
    }

    async function loadVersionCatalog(force = false) {
      if (state.versionCatalogLoading || state.versionDownloadActive) {
        return;
      }

      state.versionCatalogLoading = true;
      onlineCatalogError = undefined;
      const request = context.beginRequest?.('versions');
      const requestToken = ++state.versionCatalogLoadToken;
      const initialSelection = versionCatalog.value || versionSelect.value;
      versionCatalog.disabled = false;
      versionSearch.disabled = false;
      versionTypeFilter.disabled = false;
      refreshVersionsButton.disabled = true;
      if (!state.versionCatalogLoaded) {
        seedCatalogWithLocalProfiles();
        renderVersionCatalog(initialSelection);
        seedLoaderCatalogWithLocalProfiles();
      }
      versionEmpty.textContent = '正在加载在线版本，可继续使用已安装版本…';
      let catalogError;

      // Local disk scans and the online catalog are separate modules. Either one
      // can populate the list without waiting for the other one to settle.
      void Promise.resolve().then(() => context.refreshLocalProfiles(force)).then(() => {
        if (requestToken !== state.versionCatalogLoadToken || state.versionDownloadActive) return;
        if (state.versionCatalogLoaded) state.remoteVersions = mergeRemoteAndLocalVersions(state.remoteVersions);
        else seedCatalogWithLocalProfiles();
        renderVersionCatalog(versionCatalog.value || initialSelection);
        if (catalogError) versionEmpty.textContent = `在线版本加载失败：${readableError(catalogError)}`;
        void loadLoaderCatalog(force);
      }).catch((error) => {
        if (requestToken === state.versionCatalogLoadToken) {
          showToast(`已安装版本读取失败，在线版本仍可使用：${readableError(error)}`, true);
        }
      });

      try {
        const result = minecraft
          ? await minecraft.listVersions({ force })
          : await delay(250).then(fallbackVersionResult);
        if (requestToken !== state.versionCatalogLoadToken || request?.signal.aborted) return;
        state.remoteVersions = mergeRemoteAndLocalVersions(result.versions);
        state.versionCatalogLoaded = true;
        renderVersionCatalog(versionCatalog.value || initialSelection);
        void loadLoaderCatalog(force);
      } catch (error) {
        if (requestToken !== state.versionCatalogLoadToken) return;
        catalogError = error;
        onlineCatalogError = error;
        const message = readableError(error);
        versionEmpty.textContent = state.localProfiles.length > 0
          ? `已加载 ${state.localProfiles.length} 个启动配置；在线版本加载失败：${message}`
          : `版本加载失败：${message}`;
        showToast(message);
      } finally {
        request?.finish();
        if (requestToken === state.versionCatalogLoadToken) {
          state.versionCatalogLoading = false;
          updateVersionAction();
        }
      }
    }


    return { selectedRemoteVersion, renderLocalProfileOptions, loadLocalProfiles, localBaseProfiles,
      seedCatalogWithLocalProfiles, mergeRemoteAndLocalVersions, selectedLoaderVersion, localLoaderVersions,
      seedLoaderCatalogWithLocalProfiles, renderLoaderCatalog, loadLoaderCatalog, updateVersionAction,
      renderVersionCatalog, invalidateVersionCatalogForDirectoryChange, reloadLocalProfilesForDirectoryChange, loadVersionCatalog };
  }
  const exported = { createVersionCatalogUi };
  if (typeof module === 'object' && module.exports) module.exports = exported;
  else Object.assign(root.launcherUiModules ??= {}, exported);
})(globalThis);
