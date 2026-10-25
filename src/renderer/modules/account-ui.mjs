export function renderAccountList(context) {
  const { state, accountList, accountEmpty, skinUrlForAccount, applySkinAvatar, accountsApi,
    updateAccountCard, showToast, readableError, selectAccount, skinModelNames, setAccountSkinModel,
    removeAccount } = context;
  accountList.replaceChildren();
  accountEmpty.hidden = state.accountState.accounts.length > 0;

  for (const account of state.accountState.accounts) {
    const row = document.createElement('div');
    row.className = 'account-row';
    row.classList.toggle('is-current', account.id === state.accountState.currentId);

    const avatar = document.createElement('span');
    avatar.className = 'account-row-avatar';
    const skinUrl = skinUrlForAccount(account);
    applySkinAvatar(avatar, account);
    avatar.textContent = skinUrl ? '' : account.name.slice(0, 1).toUpperCase();

    const copy = document.createElement('span');
    copy.className = 'account-row-copy';
    if (account.type === 'offline') {
      const nameInput = document.createElement('input');
      nameInput.type = 'text';
      nameInput.className = 'account-row-name-input';
      nameInput.value = account.name;
      nameInput.maxLength = 16;
      nameInput.title = '点击修改玩家 ID（3–16 位英文字母、数字或下划线）';
      nameInput.spellcheck = false;
      let renameQueue = Promise.resolve();
      let renameRevision = 0;
      let pendingName = null;
      const latestAccount = () => state.accountState.accounts.find((item) => item.id === account.id);
      const commitRename = () => {
        const currentAccount = latestAccount();
        if (!currentAccount) return;
        const newName = nameInput.value.trim();
        if (!newName) {
          nameInput.value = currentAccount.name;
          return;
        }
        if (newName === pendingName || (!pendingName && newName === currentAccount.name)) {
          return renameQueue;
        }
        const revision = ++renameRevision;
        pendingName = newName;
        // Save successive edits in order so an earlier slow response cannot undo a later name.
        renameQueue = renameQueue.then(async () => {
          try {
            const renamed = accountsApi?.rename
              ? (await accountsApi.rename(account.id, newName)).accounts.find((item) => item.id === account.id)
              : { name: newName };
            if (!renamed || !latestAccount()) return;
            state.accountState = {
              ...state.accountState,
              accounts: state.accountState.accounts.map((item) => (
                item.id === account.id ? { ...item, name: renamed.name, updatedAt: renamed.updatedAt } : item
              ))
            };
            state.accountState.current = state.accountState.accounts.find((item) => item.id === state.accountState.currentId) ?? null;
            const savedAccount = latestAccount();
            applySkinAvatar(avatar, savedAccount);
            avatar.textContent = skinUrlForAccount(savedAccount) ? '' : savedAccount.name.slice(0, 1).toUpperCase();
            updateAccountCard();
            if (revision === renameRevision) {
              if (nameInput.value.trim() === newName) nameInput.value = savedAccount.name;
              showToast(`已改名：${savedAccount.name}`);
            }
          } catch (error) {
            if (revision === renameRevision) {
              if (nameInput.value.trim() === newName) nameInput.value = latestAccount()?.name ?? '';
              showToast(readableError(error));
            }
          } finally {
            if (revision === renameRevision) pendingName = null;
          }
        });
        return renameQueue;
      };
      nameInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          nameInput.blur();
        }
      });
      nameInput.addEventListener('blur', commitRename);
      copy.append(nameInput);
    } else {
      const name = document.createElement('strong');
      name.textContent = account.name;
      copy.append(name);
    }
    const detail = document.createElement('small');
    const supported = ['offline', 'microsoft', 'yggdrasil'].includes(account.type);
    detail.textContent = account.type === 'offline'
      ? `离线账户 · ${account.uuid}`
      : account.type === 'yggdrasil'
        ? `LittleSkin 外置 · ${account.uuid}`
        : account.type === 'microsoft'
          ? `Microsoft · ${account.uuid}`
          : '不支持的账户类型';
    if (account.loginError) {
      detail.textContent = account.loginError;
      detail.title = account.loginError;
    }
    copy.append(detail);

    const actions = document.createElement('span');
    actions.className = 'account-row-actions';

    const selectButton = document.createElement('button');
    selectButton.type = 'button';
    selectButton.textContent = !supported ? '不可用' : account.id === state.accountState.currentId ? '当前' : '使用';
    selectButton.disabled = !supported || account.id === state.accountState.currentId;
    if (supported) selectButton.addEventListener('click', () => selectAccount(account.id));
    actions.append(selectButton);

    if (account.type === 'offline') {
      const skinButton = document.createElement('button');
      skinButton.type = 'button';
      skinButton.className = 'skin-model-button';
      const nextSkinModel = account.skinModel === 'alex' ? 'steve' : 'alex';
      skinButton.textContent = '切换';
      skinButton.title = `切换为${skinModelNames[nextSkinModel]}`;
      skinButton.addEventListener('click', () => setAccountSkinModel(account.id, nextSkinModel));
      actions.append(skinButton);
    }

    const removeButton = document.createElement('button');
    removeButton.type = 'button';
    removeButton.className = 'remove-account-button';
    removeButton.textContent = '删除';
    removeButton.addEventListener('click', () => removeAccount(account.id));
    actions.append(removeButton);

    row.append(avatar, copy, actions);
    accountList.append(row);
  }
}
