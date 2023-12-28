const controller = require('./controller');
const advModel = require('./advMockModel.js');
const caseModel = require('./caseModel.js');
const interfaceModel = require('models/interface.js');
const yapi = require('yapi.js');
const mongoose = require('mongoose');
const _ = require('underscore');
const path = require('path');
const lib = require(path.resolve(yapi.WEBROOT, 'common/lib.js'));
const Mock = require('mockjs');
const mockExtra = require(path.resolve(yapi.WEBROOT, 'common/mock-extra.js'));

function arrToObj(arr) {
  let obj = { 'Set-Cookie': [] };
  arr.forEach(item => {
    if (item.name === 'Set-Cookie') {
      obj['Set-Cookie'].push(item.value);
    } else obj[item.name] = item.value;
  });
  return obj;
}

module.exports = function () {
  yapi.connect.then(function () {
    let Col = mongoose.connection.db.collection('adv_mock');
    Col.createIndex({
      interface_id: 1
    });
    Col.createIndex({
      project_id: 1
    });

    let caseCol = mongoose.connection.db.collection('adv_mock_case');
    caseCol.createIndex({
      interface_id: 1
    });
    caseCol.createIndex({
      project_id: 1
    });
  });

  async function checkCase(ctx, interfaceId) {
    let reqParams = Object.assign({}, ctx.query, ctx.request.body);
    let caseInst = yapi.getInst(caseModel);

    // let ip = ctx.ip.match(/\d+.\d+.\d+.\d+/)[0];
    // request.ip

    let ip = yapi.commons.getIp(ctx);
    //   数据库信息查询
    // 过滤 开启IP
    let listWithIp = await caseInst.model
      .find({
        interface_id: interfaceId,
        ip_enable: true,
        ip: ip
      })
      .select('_id params case_enable');

    let matchList = [];
    listWithIp.forEach(item => {
      let params = item.params;
      if (item.case_enable && lib.isDeepMatch(reqParams, params)) {
        matchList.push(item);
      }
    });

    // 其他数据
    if (matchList.length === 0) {
      let list = await caseInst.model
        .find({
          interface_id: interfaceId,
          ip_enable: false
        })
        .select('_id params case_enable');
      list.forEach(item => {
        let params = item.params;
        if (item.case_enable && lib.isDeepMatch(reqParams, params)) {
          matchList.push(item);
        }
      });
    }

    if (matchList.length > 0) {
      let maxItem = _.max(matchList, item => (item.params && Object.keys(item.params).length) || 0);
      return maxItem;
    }
    return null;
  }

  async function handleByCase(caseData) {
    let caseInst = yapi.getInst(caseModel);
    let result = await caseInst.get({
      _id: caseData._id
    });
    return result;
  }

  this.bindHook('add_router', function (addRouter) {
    addRouter({
      controller: controller,
      method: 'get',
      path: 'advmock/get',
      action: 'getMock'
    });
    addRouter({
      controller: controller,
      method: 'post',
      path: 'advmock/save',
      action: 'upMock'
    });
    addRouter({
      /**
       * 保存期望
       */
      controller: controller,
      method: 'post',
      path: 'advmock/case/save',
      action: 'saveCase'
    });

    addRouter({
      controller: controller,
      method: 'get',
      path: 'advmock/case/get',
      action: 'getCase'
    });

    addRouter({
      /**
       * 获取期望列表
       */
      controller: controller,
      method: 'get',
      path: 'advmock/case/list',
      action: 'list'
    });

    addRouter({
      /**
       * 删除期望列表
       */
      controller: controller,
      method: 'post',
      path: 'advmock/case/del',
      action: 'delCase'
    });

    addRouter({
      /**
       * 隐藏期望列表
       */
      controller: controller,
      method: 'post',
      path: 'advmock/case/hide',
      action: 'hideCase'
    });
  });
  this.bindHook('interface_del', async function (id) {
    let inst = yapi.getInst(advModel);
    await inst.delByInterfaceId(id);
  });
  this.bindHook('project_del', async function (id) {
    let inst = yapi.getInst(advModel);
    await inst.delByProjectId(id);
  });
  this.bindHook('project_copy', async function (data) {
    // 将新的项目id和老的项目id传过来，复制mock数据
    const { newId, oldId, interfaceMap } = data;
    // 将老项目中的mock数据复制到新项目中
    let interInst = yapi.getInst(interfaceModel);
    let interList = await interInst.getByProjectId(oldId); // 所有的接口列表
    const inst = yapi.getInst(caseModel);
    if (interList && interList.length > 0) {
      interList.forEach(async item => {
        const _interfaceId = item._id;
        const advItems = await inst.list(_interfaceId);
        if (advItems && advItems.length > 0) {
          advItems.forEach(async advItem => {
            let newItem = JSON.parse(JSON.stringify(advItem));
            delete newItem._id;
            newItem.project_id = newId;
            newItem.interface_id = interfaceMap.get(item._id);
            await inst.save(newItem);
          });
        }
      });
    }
  });
  /**
   * let context = {
      projectData: project,
      interfaceData: interfaceData,
      ctx: ctx,
      mockJson: res 
    } 
   */
  this.bindHook('mock_after', async function (context) {
    let interfaceId = context.interfaceData._id;
    let caseData = await checkCase(context.ctx, interfaceId);

    // 只有开启高级mock才可用
    if (caseData && caseData.case_enable) {
      // 匹配到高级mock
      let data = await handleByCase(caseData);

      context.mockJson = yapi.commons.json_parse(data.res_body);
      try {
        context.mockJson = Mock.mock(
          mockExtra(context.mockJson, {
            query: context.ctx.query,
            body: context.ctx.request.body,
            params: Object.assign({}, context.ctx.query, context.ctx.request.body)
          })
        );
      } catch (err) {
        yapi.commons.log(err, 'error');
      }

      context.resHeader = arrToObj(data.headers);
      context.httpCode = data.code;
      context.delay = data.delay;
      return true;
    }
    let inst = yapi.getInst(advModel);
    let data = await inst.get(interfaceId);

    if (!data || !data.enable || !data.mock_script) {
      return context;
    }

    // mock 脚本
    let script = data.mock_script;
    await yapi.commons.handleMockScript(script, context);
  });
};
