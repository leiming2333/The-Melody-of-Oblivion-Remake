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
      const commitRename = async () => {
        const newName = nameInput.value.trim();
        if (!newName || newName === account.name) {
          nameInput.value = account.name;
          return;
        }
        try {
          if (accountsApi?.rename) {
            state.accountState = await accountsApi.rename(account.id, newName);
          } else {
            state.accountState.accounts = state.accountState.accounts.map((item) => (
              item.id === account.id ? { ...item, name: newName } : item
            ));
            state.accountState.current = state.accountState.accounts.find((a) => a.id === state.accountState.currentId) ?? null;
          }
          updateAccountCard();
          showToast(`已改名：${newName}`);
        } catch (error) {
          nameInput.value = account.name;
          showToast(readableError(error));
        }
      };
      nameInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          nameInput.blur();
        }
      });
      nameInput.addEventListener('blur', commitRename, { once: true });
      copy.append(nameInput);
    } else {
      const name = document.createElement('strong');
      name.textContent = account.name;
      copy.append(name);
    }
    const detail = document.createElement('small');
    detail.textContent = account.type === 'offline'
      ? `离线账户 · ${account.uuid}`
      : account.type === 'yggdrasil'
        ? `LittleSkin 外置 · ${account.uuid}`
        : `Microsoft · ${account.uuid}`;
    if (account.loginError) {
      detail.textContent = account.loginError;
      detail.title = account.loginError;
    }
    copy.append(detail);

    const actions = document.createElement('span');
    actions.className = 'account-row-actions';

    const selectButton = document.createElement('button');
    selectButton.type = 'button';
    selectButton.textContent = account.id === state.accountState.currentId ? '当前' : '使用';
    selectButton.disabled = account.id === state.accountState.currentId;
    selectButton.addEventListener('click', () => selectAccount(account.id));
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
