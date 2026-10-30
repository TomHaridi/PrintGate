import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';

/// 端上排版合成：文字速印 / 发票合排 / 身份证合排。
///
/// 后端的 textPdf / imagesPdf / idcardPdf 都是 requireAdmin 接口，小程序令牌不认，
/// 所以小程序是在 canvas 里合成了图片再走 /api/mp/files + /api/mp/print。
/// iOS 端照抄同一套算法（画布 1240px 宽，比例与纸张一致），保证两端出图一模一样。
class Compose {
  static const double _pageWidth = 1240;

  static const Map<String, double> _ratio = {
    'A4': 210 / 297,
    'A3': 297 / 420,
    'A5': 148 / 210,
    'A6': 105 / 148,
    'Letter': 216 / 279,
    'Legal': 216 / 356,
    'B5': 176 / 250,
    '16K': 195 / 270,
  };

  static ({int w, int h}) pagePx(String media) {
    final r = _ratio[media] ?? _ratio['A4']!;
    return (w: _pageWidth.toInt(), h: (_pageWidth / r).round());
  }

  // ---------- 文字速印 ----------
  static Future<File> text({
    required String body,
    String title = '',
    double fontSize = 12,
    String media = 'A4',
  }) async {
    final size = pagePx(media);
    final recorder = ui.PictureRecorder();
    final canvas = Canvas(recorder);
    final w = size.w.toDouble();
    final h = size.h.toDouble();

    canvas.drawRect(Rect.fromLTWH(0, 0, w, h), Paint()..color = Colors.white);

    const margin = 56.0;
    var y = margin;

    if (title.trim().isNotEmpty) {
      final titleSize = (fontSize * 1.6).clamp(0, 30).toDouble();
      final p = _paragraph(title.trim(), titleSize, w - margin * 2, align: TextAlign.center);
      canvas.drawParagraph(p, Offset(margin, y));
      y += fontSize * 1.6 + 8;
    }

    final p = _paragraph(body, fontSize, w - margin * 2);
    canvas.drawParagraph(p, Offset(margin, y));

    return _export(recorder, size.w, size.h);
  }

  // ---------- 发票合排 ----------
  static Future<File> invoice({
    required List<String> images,
    int per = 2,
    String media = 'A4',
  }) async {
    final size = pagePx(media);
    final recorder = ui.PictureRecorder();
    final canvas = Canvas(recorder);
    final w = size.w.toDouble();
    final h = size.h.toDouble();

    canvas.drawRect(Rect.fromLTWH(0, 0, w, h), Paint()..color = Colors.white);

    const margin = 28.0;
    const gap = 14.0;
    final uw = w - margin * 2;
    final uh = h - margin * 2;
    final cols = per == 4 ? 2 : 1;
    final rows = per == 4 ? 2 : (per == 2 ? 2 : 1);
    final cellW = (uw - gap * (cols - 1)) / cols;
    final cellH = (uh - gap * (rows - 1)) / rows;

    for (var i = 0; i < per && i < images.length; i++) {
      final img = await _decode(images[i]);
      final c = i % cols;
      final r = i ~/ cols;
      _drawCover(canvas, img, margin + c * (cellW + gap), margin + r * (cellH + gap), cellW, cellH);
    }

    return _export(recorder, size.w, size.h);
  }

  // ---------- 身份证正反合排 ----------
  static Future<File> idCard({
    String? front,
    String? back,
    String media = 'A4',
  }) async {
    final size = pagePx(media);
    final recorder = ui.PictureRecorder();
    final canvas = Canvas(recorder);
    final w = size.w.toDouble();
    final h = size.h.toDouble();

    canvas.drawRect(Rect.fromLTWH(0, 0, w, h), Paint()..color = Colors.white);

    const margin = 36.0;
    const gap = 18.0;
    final uw = w - margin * 2;
    final uh = h - margin * 2;
    final slotH = (uh - gap) / 2;

    final slots = [
      (src: front, top: margin, label: '正面'),
      (src: back, top: margin + slotH + gap, label: '反面'),
    ];

    for (final s in slots) {
      final rect = Rect.fromLTWH(margin, s.top, uw, slotH);
      // 淡裁切线，方便用户沿边裁
      canvas.drawRect(
        rect,
        Paint()
          ..style = PaintingStyle.stroke
          ..strokeWidth = 0.5
          ..color = const Color(0xFFCBD5E1),
      );
      final src = s.src;
      if (src != null && src.isNotEmpty) {
        final img = await _decode(src);
        _drawCover(canvas, img, margin, s.top, uw, slotH);
      } else {
        final p = _paragraph('（未上传${s.label}）', 11, uw, align: TextAlign.center, color: const Color(0xFF94A3B8));
        canvas.drawParagraph(p, Offset(margin, s.top + slotH / 2 - 8));
      }
    }

    return _export(recorder, size.w, size.h);
  }

  // ---------- 内部 ----------
  static ui.Paragraph _paragraph(
    String text,
    double fontSize,
    double maxWidth, {
    TextAlign align = TextAlign.left,
    Color color = Colors.black,
  }) {
    final builder = ui.ParagraphBuilder(ui.ParagraphStyle(
      textAlign: align,
      fontSize: fontSize,
      height: 1.42,
      fontFamily: null,
    ))
      ..pushStyle(ui.TextStyle(color: color, fontSize: fontSize))
      ..addText(text);
    final p = builder.build()..layout(ui.ParagraphConstraints(width: maxWidth));
    return p;
  }

  /// cover 模式：等比放大到铺满矩形，居中裁切（身份证/发票都这么处理）
  static void _drawCover(Canvas c, ui.Image img, double x, double y, double w, double h, {int rotate = 0}) {
    c.save();
    c.clipRect(Rect.fromLTWH(x, y, w, h));
    c.translate(x + w / 2, y + h / 2);
    if (rotate != 0) c.rotate(rotate * 3.1415926535 / 180);
    final iw = img.width.toDouble();
    final ih = img.height.toDouble();
    var dw = w;
    var dh = h;
    if (rotate == 90 || rotate == 270) {
      dw = h;
      dh = w;
    }
    final scale = (dw / iw) > (dh / ih) ? dw / iw : dh / ih;
    c.drawImage(img, Offset(-iw * scale / 2, -ih * scale / 2), Paint()..filterQuality = FilterQuality.high);
    c.restore();
  }

  static Future<ui.Image> _decode(String path) async {
    final bytes = await File(path).readAsBytes();
    final codec = await ui.instantiateImageCodec(bytes);
    final frame = await codec.getNextFrame();
    return frame.image;
  }

  static Future<File> _export(ui.PictureRecorder recorder, int w, int h) async {
    final picture = recorder.endRecording();
    final img = await picture.toImage(w, h);
    final data = await img.toByteData(format: ui.ImageByteFormat.png);
    final dir = Directory.systemTemp.createTempSync('pg_compose');
    final file = File('${dir.path}/composed.png');
    await file.writeAsBytes(data!.buffer.asUint8List());
    return file;
  }

  /// 合成产物的文件名（打印记录里显示这个，不能是 tmp_xxx）
  static String nameOf(String mode) {
    switch (mode) {
      case 'text':
        return '文字速印.png';
      case 'invoice':
        return '发票合排.png';
      case 'idcard':
        return '身份证合排.png';
      default:
        return '打印.png';
    }
  }
}
