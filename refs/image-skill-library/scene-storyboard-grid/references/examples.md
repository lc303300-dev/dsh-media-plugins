# 纯文字示例

这些示例不定义契约，不对应任何需要上传的范例图片。示例中的城市、材质、主体和镜头不能自动成为当前任务事实。

## 单参考示例骨架

输入：一张室内雕塑场景底图；背面不可见，没有真实孔洞。

可用镜头：三分之四整体、低角尺度、侧掠厚度、浅景深近景、材质微距、高角投影、真实柱体前景遮挡、紧凑立面关系、保守裁切特写。禁用背后机位与孔洞窥视。

```text
OUTPUT CONTRACT
Create one complete image at the confirmed aspect ratio, containing exactly nine equal panels in a strict 3×3 grid. Keep all nine internal panel compositions vertical because the scene reference is portrait-oriented. No titles, panel numbers, captions, watermarks, UI, or decorative outer frame.

REFERENCE ROLES
Reference image 1 is the closed-world authority for the entire scene and for every visible property of the single sculpture. Do not invent unseen rear geometry.

IDENTITY AND CONTINUITY
All nine panels show the exact same sculpture, in the exact same installation position and scale, in the same room at the same moment...

SHOT COVERAGE
Select nine evidence-supported views covering the confirmed front and side volume, scale relationship, material detail, real foreground occlusion, and physically correct shadow. Do not use a rear view or a through-hole view.

ALLOWED VARIATION
Only camera position, viewing angle, crop, shot size, focal length, depth of field, and focus distance may change.

PHYSICAL RELATIONSHIPS
Preserve the original perspective, contact, occlusion order, reflections, and shadow direction...

CLOSED-WORLD RULE
Do not add, remove, repair, complete, or redesign any object or hidden structure.

OUTPUT NEGATIVES
No duplicated subject, no geometry drift, no new room elements, no temporal progression, no text overlays, and no layout other than one strict 3×3 sheet.
```

## 双参考 Logo 示例骨架

底图定义城市安装位置、尺度、建筑前后关系、天气与光影；设定图定义唯一 Logo 的字符、厚度、倒角和金属材质。设定图的多视图不是多个 Logo。

在 `REFERENCE ROLES` 中明确：scene relationships follow reference 1; identity follows reference 2; ignore reference 2 background and presentation layout. 在 `SHOT COVERAGE` 中只选择底图支持的侧掠、尺度、遮挡、投影和材质镜头。

## 反例：九种时间与材质

错误：九格分别改成清晨、正午、夜晚、雨天，并让主体在每格使用不同材质。

修正：所有格锁定同一时刻、天气、曝光、光线与材质；只改变摄影机参数。

## 边界：要求未知背面

若底图看不到背面，不能写“完整展示背面结构”。将该格降级为证据支持的斜角、裁切或对焦变化；若背面是任务关键，停止并请求用户通过契约升级后的确定性素材流程处理，而不是临时塞入第三张参考图。

## 边界：场景没有孔洞

不得出现 through-hole shot。改用已存在的前景遮挡、侧掠厚度、材质微距或高角投影镜头。

## 横向底图与竖向外层画布

输入：用户确认最终整张图片为 3:4，但 `scene-base` 是横向构图。

要求：最终画布仍为竖向 3:4；九个内部小画面全部保持横向构图，并以严格 3×3 等大网格排版。不得把每个小画面强行裁成竖向，也不得横竖混排。通过统一分隔和整体留白适配外层画布，禁止拉伸场景。

## 条件化选镜示例

事实账本确认：主体侧面和厚度可见、前方有建筑遮挡、地面投影清楚；未发现真实孔洞，金属表面只能确认光滑反射，不能确认拉丝或风化，底图也没有暖色轮廓光。

当前提示词可写侧掠厚度、真实前景遮挡和高角投影；不得写 through-hole view、brushed weathered surface 或 warm edge light。其余格使用三分之四关系、低角尺度、保守斜角、裁切、焦段、景深和对焦差异补足。
