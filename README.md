# 食品安全与营养相互作用分析助手
分析同餐/同杯/同锅的食物、调料、补剂或药物的关键成分、可能不适、食品安全风险，并给出风险等级与建议。

> 体验网址：https://food.xfxuezhang.cn/

<img width="1575" height="899" alt="image" src="https://github.com/user-attachments/assets/74cc2152-919b-4147-84f9-83a29aa42df5" />

---

**1. 部署步骤：**     
cloudflare -> 计算和AI -> Workers和Pages -> 创建应用程序 -> 从Hello World开始 -> (复制worker.js进去) -> 部署

**2. 环境变量：**   
设置 -> 变量和机密 -> 添加

```bash
# 采用OpenAI格式：
AI_BASE_URL
AI_MODEL
AI_TOKEN
```

