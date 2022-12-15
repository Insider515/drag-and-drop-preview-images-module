/*! =========================================================
 * drag.and.drop.file.input.css
 *
 * Maintainers:
 *      Mikhail Khravtsov
 *          - Gmail: khravtsov.m@gmail.com
 *          - Github:  Insider515
 *
 * =========================================================
 *
 * Drag&DropFileInput is released under the MIT License
 * Copyright (c) 2019 Mikhail Khravtsov
 * 
 * Permission is hereby granted, free of charge, to any person
 * obtaining a copy of this software and associated documentation
 * files (the "Software"), to deal in the Software without
 * restriction, including without limitation the rights to use,
 * copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the
 * Software is furnished to do so, subject to the following
 * conditions:
 * 
 * The above copyright notice and this permission notice shall be
 * included in all copies or substantial portions of the Software.
 * 
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
 * EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES
 * OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
 * NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT
 * HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
 * WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
 * FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR
 * OTHER DEALINGS IN THE SOFTWARE.
 *
 * ========================================================= */
//Створюємо змінні
var $fileInput = $('.file-input');
var $droparea = $('.file-drop-area');

//Зміна стилів при перетягуванні файлів
$fileInput.on('dragenter focus click', function () {
    $droparea.addClass('is-active');
});
$fileInput.on('dragleave blur drop', function () {
    $droparea.removeClass('is-active');
});

//Змінна черги
let dtf = new DataTransfer();

//Подія вибору файлів
$fileInput.on('change', function () {
    reloadFiles();
    var filesCount = $(this)[0].files.length;
    var $textContainer = $(this).prev();
    if (filesCount === 1) {
        $textContainer.text('обран 1' + titleName(filesCount));
    } else {
        $textContainer.text('обрано ' + filesCount + titleName(filesCount));
    }
});

//Схиляння у звʼязку з кількістю обранних файлів
function titleName(filesCount) {
    if (filesCount == 1) {
        fileTitle = ' файл'
    } else if (((filesCount > 1) && (filesCount < 5)) || filesCount == 0) {
        fileTitle = ' файли'
    } else {
        fileTitle = ' файлiв'
    }
    return fileTitle;
}

//Створення попереднього перегляду
document.querySelector("#image").addEventListener("change", function () {
    countImg = this.files.length;
    let obj = {};
    document.getElementById("preview").innerHTML = '';
    for (let i = 0; i < countImg; i++) {
        if (this.files[i]) {
            obj[`fr${i}`] = new FileReader();
            let span1 = elementBilder('span');
            span1 = span1('X');
            span1 = span1('class="previewImageButtonClose" onclick="clearInputFile(' + i + ');"');
            let div2 = elementBilder('div');
            div2 = div2(span1);
            div2 = div2('id="preview' + i + '" class="previewImage"');
            let span2 = elementBilder('span');
            span2 = span2(this.files[i].size + ' KB');
            span2 = span2('id="size' + i + '"');
            let div1 = elementBilder('div');
            div1 = div1(div2 + span2);
            document.getElementById("preview").innerHTML += div1('id="parent-preview' + i + '" style="text-align: center;"');
            obj[`fr${i}`].addEventListener("load", function () {
                document.getElementById("preview" + i).style.backgroundImage = "url(" + obj[`fr${i}`].result + ")";
            }, false);
            obj[`fr${i}`].readAsDataURL(this.files[i]);
        }
    }
});

//Повне видалення
function clearInputFile_() {
    document.getElementById('image').value = '';
    document.querySelector('.file-msg').textContent = 'або перетягніть його в дану ділянку';
    document.getElementById("preview").innerHTML = '';
    dtf = new DataTransfer();
}

//Вибіркове видалення файлів
function clearInputFile(i) {
    elem = document.getElementById("parent-preview" + i)
    var parent = document.getElementById("preview")
    var index = Array.prototype.indexOf.call(parent.children, elem);
    let dt = new DataTransfer()
    if (typeof dtf.items == undefined) {
        let tmpFiles_ = document.querySelector('input[name="image[]"]').files;
        countFiles = tmpFiles_.length;
        for (let ii = 0; ii < countFiles; ii++) {
            if (ii != index) {
                dt.items.add(tmpFiles_[ii])
            }
        }
    } else {
        countFiles = dtf.items.length
        for (let ii = 0; ii < countFiles; ii++) {
            if (ii != index) {
                dt.items.add(dtf.files[ii])
            }
        }
        dtf = dt;
    }
    document.querySelector('input[name="image[]"]').files = dt.files
    document.getElementById('preview' + i).remove();
    document.getElementById('size' + i).remove();
    countSliseFiles = parseInt(document.querySelector('.file-msg').textContent.split(' ')[1]) - 1
    if (countSliseFiles < 1) {
        document.querySelector('.file-msg').textContent = 'або перетягніть його в дану ділянку'
    } else {
        document.querySelector('.file-msg').textContent = 'обрано ' + countSliseFiles + titleName(countSliseFiles);
    }
}

//Оновлення черги файлів
function reloadFiles() {
    if (typeof dtf.items != undefined) {
        if (dtf.items.length == 0) {
            let tmpFiles_ = document.querySelector('input[name="image[]"]').files;
            countFiles = tmpFiles_.length;
            for (let ix = 0; ix < countFiles; ix++) {
                dtf.items.add(tmpFiles_[ix])
            }
        } else {
            let tmpFiles_ = document.querySelector('input[name="image[]"]').files;
            countFiles = tmpFiles_.length;
            for (let ix = 0; ix < countFiles; ix++) {
                dtf.items.add(tmpFiles_[ix])
            }
            document.querySelector('input[name="image[]"]').files = dtf.files
        }
    }
}

//Конструктор елементів
let elementBilder = htmlTeg => innerHtml => attribute => `<${htmlTeg} ${attribute}>${innerHtml}</${htmlTeg}>`;