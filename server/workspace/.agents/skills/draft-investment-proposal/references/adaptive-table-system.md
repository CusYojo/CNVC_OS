# 自适应表格系统

本文件只决定列角色和列宽分配。案例精确版式任务的颜色、字体、边框、单元格边距和行规则全部由[案例精确版式契约](exact-case-style.md)控制。

## 样式选择

| 数据 | style | 默认 caption_policy |
|---|---|---|
| 股权结构、历史融资、投资方案、风险/条件矩阵 | grid | natural |
| 历史财务、经营预测、回报情景、可比估值 | three-line | natural |
| 产品或里程碑比较 | grid | natural |

同一文件可以同时使用两种样式。不得为了“统一”把所有表格做成同一种全框线。

## 列角色

| role | 初始 width_weight | 正文对齐 |
|---|---:|---|
| percent | 0.75 | right |
| numeric | 0.85 | right |
| date | 0.90 | center |
| label | 1.00 | center |
| status | 1.10 | center |
| narrative | 2.20 | left |

根据最长内容微调权重，但 numeric/percent 不得因单位文字被扩成最宽列。先为叙述列留足空间，再压缩短字段。角色不同、内容长度明显不同却使用相同 width_weight 或相同 grid width，判定为“禁止等宽”硬错误。

## 宽度算法

1. 选择总宽：叙述列或五列以上使用 8306 DXA；纯短字段 2–4 列可使用 6600–7600 DXA。
2. 按 width_weight 归一化。
3. percent 最小 850 DXA，numeric/date 最小 1050 DXA，label 最小 1200 DXA，narrative 最小 2000 DXA。
4. 调整后总和必须等于表格总宽。
5. 渲染检查叙述列是否每行只能容纳少量汉字；若是，重新分配，不缩小到 9 pt 以下。

## 表头与边框

- grid 表头在案例精确版式任务中固定使用 C0C0C0；仅非案例任务允许 D9D9D9。
- three-line 在案例精确版式任务中固定使用顶线1.5 pt、表头下线0.5 pt、表底线1.5 pt且无竖线。
- 表头加粗居中并重复显示；正文垂直居中。
- 内边距：左右 100–140 DXA，上下 80–120 DXA。

## 表题

默认使用自然引导，如`公司交割后股权结构如下：`或`管理层经营预测如下：`。只有全文需要交叉引用且存在三张以上同类表格时才使用 numbered。避免每张表机械写`表1、表2`形成学术报告感。

## 分页

- 表题与表头/首行保持同页。
- 长表自然跨页并重复表头，禁止固定行高。
- 不要求整张表从新页开始；上一页剩余空间能容纳表题、表头和至少一行时继续排版。
- 任何非末页正文占用不足页面高度 50% 时，检查下一页是否因表格 keep-with-next 或手动分页造成可避免空白。

## Table plan 示例

```json
{
  "slot": "transaction",
  "title": "投资方案",
  "style": "grid",
  "caption_policy": "natural",
  "columns": [
    {"name": "投资形式", "role": "label", "width_weight": 1.0},
    {"name": "金额", "role": "numeric", "width_weight": 0.8},
    {"name": "定价口径", "role": "narrative", "width_weight": 1.7},
    {"name": "股权权益", "role": "percent", "width_weight": 0.8},
    {"name": "价款用途", "role": "narrative", "width_weight": 2.1}
  ]
}
```
