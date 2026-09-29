/**
 * ps-commands.js — 几个 batchPlay 命令的"纯数据"写法
 *
 * 单独拎出来的原因：这些命令本身就是一堆 JSON，在 Photoshop 外面也能构造、也能检查。
 * 放在这里之后，测试可以直接断言"发给 PS 的到底是什么形状"
 * （比如蒙版那条用的必须是 revealAll = 白色），不用真开 PS。
 *
 * 本文件不 require 任何东西，方便脱离宿主做单元测试。
 */

/**
 * 把一批图层凑成多选：第一条替换现有选择，后面的累加。
 * selectionModifier 只有第二条起才需要——给第一条加就成了"加选"。
 */
function selectLayers(ids) {
  var cmds = [];
  for (var i = 0; i < ids.length; i++) {
    var c = {
      _obj: 'select',
      _target: [{ _ref: 'layer', _id: ids[i] }],
      makeVisible: false
    };
    if (i > 0) c.selectionModifier = { _enum: 'selectionModifierType', _value: 'addToSelection' };
    cmds.push(c);
  }
  return cmds;
}

/** 选中单个图层 */
function selectLayer(layerId) {
  return {
    _obj: 'select',
    _target: [{ _ref: 'layer', _id: layerId }],
    makeVisible: false
  };
}

/** 图层 → 编组图层（对当前选择生效），编完新组就是当前图层 */
function groupLayers() {
  return {
    _obj: 'groupLayers',
    _target: [{ _ref: 'layer', _enum: 'ordinal', _value: 'targetEnum' }]
  };
}

/** 给某个图层（组也是图层）改名 */
function renameLayer(layerId, name) {
  return {
    _obj: 'set',
    _target: [{ _ref: 'layer', _id: layerId }],
    to: { _obj: 'layer', name: name }
  };
}

/** 新建一个空的图层组（不含任何图层） */
function makeGroup() {
  return {
    _obj: 'make',
    _target: [{ _ref: 'layer' }],
    using: { _obj: 'layerSection' },
    _options: { dialogOptions: 'dontDisplay' }
  };
}

/** 把一个图层挪进某个组里（默认落在组内最上层） */
function moveLayerInto(layerId, groupId) {
  return {
    _obj: 'move',
    _target: [{ _ref: 'layer', _id: layerId }],
    to: { _ref: 'layer', _id: groupId },
    _options: { dialogOptions: 'dontDisplay' }
  };
}

/**
 * 加一个"显示全部"的图层蒙版，也就是白色蒙版。
 *
 * 加在组上 = 给整个组一个白色蒙版：画面一点不变（白色是"全都露出来"），
 * 但后面想在蒙版上涂黑、抹掉某一块就随时可以。
 */
function addWhiteMask() {
  return {
    _obj: 'make',
    _target: [{ _ref: 'channel', _enum: 'channel', _value: 'mask' }],
    using: { _enum: 'userMaskEnabled', _value: 'revealAll' }
  };
}

module.exports = {
  selectLayers: selectLayers,
  selectLayer: selectLayer,
  groupLayers: groupLayers,
  renameLayer: renameLayer,
  makeGroup: makeGroup,
  moveLayerInto: moveLayerInto,
  addWhiteMask: addWhiteMask
};
