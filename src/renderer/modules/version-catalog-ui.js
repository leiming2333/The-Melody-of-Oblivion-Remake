(function exposeUiModules(root) {
  function createVersionCatalogUi(context) {
    let onlineCatalogError;
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

      loaderVersionSelect.disabled = loaderTypeSelect.value === 'vanilla' || (state.loaderCatalogLoading && !state.loaderVersions.length);
      updateVersionAction();
    }

    async function loadLoaderCatalog(force = false) {
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
          loaderVersionSelect.disabled = loaderType === 'vanilla';
          updateVersionAction();
        }
      }
    }

    function updateVersionAction() {
      const version = selectedRemoteVersion();
      const loaderType = loaderTypeSelect.value;
      const loader = selectedLoaderVersion();
      const busy = state.versionDownloadActive || state.fabricApiConfirmationActive || state.versionDeleteActive || state.versionVerifyActive;
      downloadVersionButton.disabled = !version || !loader || busy;
      deleteVersionButton.disabled = !loader?.installed || busy;
      clearVersionSelectionButton.disabled = !versionSelect.value || busy || state.launchRequestActive;
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
      if (loader.installed) {
        downloadVersionButton.textContent = '使用此版本';
        return;
      }
      if (state.lastDownloadFailed) {
        downloadVersionButton.textContent = '重试';
        return;
      }
      downloadVersionButton.textContent = loaderType === 'vanilla'
        ? '下载原版'
        : `安装 ${loaderNames[loaderType]}`;
    }

    function renderVersionCatalog(preferredId) {
      const query = versionSearch.value.trim().toLowerCase();
      const type = versionTypeFilter.value;
      const previousId = preferredId ?? versionCatalog.value;

      state.filteredVersions = state.remoteVersions.filter((version) => {
        const typeMatches = type === 'all' || version.type === type;
        const queryMatches = !query || version.id.toLowerCase().includes(query);
        return typeMatches && queryMatches;
      });

      const installedVersions = state.filteredVersions.filter((version) => version.installed);
      const availableVersions = state.filteredVersions.filter((version) => !version.installed);

      versionCatalog.replaceChildren();

      if (installedVersions.length > 0) {
        const installedGroup = document.createElement('optgroup');
        installedGroup.label = `已安装（${installedVersions.length}）`;
        for (const version of installedVersions) {
          const option = document.createElement('option');
          option.value = version.id;
          option.textContent = `${version.id}  ·  ${versionTypeName(version.type)}`;
          installedGroup.append(option);
        }
        versionCatalog.append(installedGroup);
      }

      if (availableVersions.length > 0) {
        const availableGroup = document.createElement('optgroup');
        availableGroup.label = `可下载（${availableVersions.length}）`;
        for (const version of availableVersions) {
          const option = document.createElement('option');
          option.value = version.id;
          option.textContent = `${version.id}  ·  ${versionTypeName(version.type)}`;
          option.disabled = version.localOnly === true;
          availableGroup.append(option);
        }
        versionCatalog.append(availableGroup);
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
        ? `共 ${state.filteredVersions.length} 个版本，发现 ${state.localProfiles.length} 个启动配置`
        : '没有符合条件的版本';
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
      if (state.versionCatalogLoading) {
        return;
      }

      state.versionCatalogLoading = true;
      onlineCatalogError = undefined;
      const request = context.beginRequest?.('versions');
      const requestToken = ++state.versionCatalogLoadToken;
      versionCatalog.disabled = false;
      versionSearch.disabled = false;
      versionTypeFilter.disabled = false;
      refreshVersionsButton.disabled = true;
      if (!state.versionCatalogLoaded) {
        seedCatalogWithLocalProfiles();
        renderVersionCatalog(versionSelect.value);
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
        renderVersionCatalog(versionSelect.value);
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
        renderVersionCatalog(versionSelect.value);
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
          refreshVersionsButton.disabled = false;
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
