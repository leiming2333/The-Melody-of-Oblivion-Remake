export async function showMods({ minecraft, dialog, list, importButton, hint, showProblem }, targetId) {
  const render = mods => {
    list.replaceChildren();
    hint.textContent = mods.length ? `${mods.length} 个 Mod。请在关闭游戏后修改；此处不检查兼容性。` : '尚无 Mod，可导入 .jar。请先确认它适用于当前游戏和加载器。';
    for (const mod of mods) {
      const row = document.createElement('div');
      row.className = 'account-row';
      const label = document.createElement('span');
      label.className = 'account-row-copy';
      label.textContent = mod.name;
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = mod.enabled ? '禁用' : '启用';
      button.onclick = async () => {
        button.disabled = true;
        try { render(await minecraft.setModEnabled(targetId, mod.name, !mod.enabled)); }
        catch (error) { showProblem(error); }
        finally { button.disabled = false; }
      };
      row.append(label, button);
      list.append(row);
    }
  };
  list.replaceChildren();
  hint.textContent = '正在读取当前实例的 Mod…';
  importButton.disabled = true;
  if (!dialog.open) dialog.showModal();
  importButton.onclick = async () => {
    importButton.disabled = true;
    try {
      const result = await minecraft.importMod(targetId);
      if (!result.canceled) render(result.mods);
    } catch (error) { showProblem(error); }
    finally { importButton.disabled = false; }
  };
  try { render(await minecraft.listMods(targetId)); }
  catch (error) { hint.textContent = '读取失败，请关闭后重试。'; showProblem(error); }
  finally { importButton.disabled = false; }
}
