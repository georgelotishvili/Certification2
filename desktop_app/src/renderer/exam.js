// გამოცდის JavaScript ფაილი

document.addEventListener('DOMContentLoaded', () => {
    // Fullscreen-ზე გადასვლა
    if (window.electronAPI) {
        window.electronAPI.setFullscreen();
    }
    
    // ვიდეოთვალის ჩართვა
    initializeCamera();
    
    // კითხვების ინიციალიზაცია
    initializeAnswerSelection();
    
    const finishButton = document.getElementById('finish-button');
    
    if (finishButton) {
        finishButton.addEventListener('click', () => {
            // Fullscreen-იდან გამოსვლა
            if (window.electronAPI) {
                window.electronAPI.exitFullscreen();
            }
            
            // მთავარ გვერდზე დაბრუნება
            setTimeout(() => {
                window.location.href = 'index.html';
            }, 100);
        });
    }
    
    // Navigation ბუტონების ფუნქციონალობა
    const navButtons = document.querySelectorAll('.nav-button');
    const documentationViewer = document.querySelector('.documentation-viewer');
    
    navButtons.forEach(button => {
        button.addEventListener('click', () => {
            // ყველა ბუტონიდან active კლასის წაშლა
            navButtons.forEach(btn => btn.classList.remove('active'));
            
            // დაკლიკულ ბუტონს active კლასის დამატება
            button.classList.add('active');
            
            // ტაბის მიხედვით ელემენტების ჩვენება/დამალვა
            const tabType = button.getAttribute('data-tab');
            
            if (tabType === 'exam') {
                // გამოცდის ტაბი - documentation-viewer უკან
                documentationViewer.classList.remove('active');
            } else if (tabType === 'documentation') {
                // დოკუმენტაციის ტაბი - documentation-viewer წინ
                documentationViewer.classList.add('active');
            }
        });
    });
});

// ჩექბოქსების ლოგიკა - მხოლოდ ერთის მონიშვნა
function initializeAnswerSelection() {
    const checkboxes = document.querySelectorAll('.answer-checkbox');
    const answerElements = document.querySelectorAll('.answer-element');
    
    checkboxes.forEach((checkbox, index) => {
        checkbox.addEventListener('change', function() {
            if (this.checked) {
                // გავუქმოთ ყველა სხვა ჩექბოქსი
                checkboxes.forEach((otherCheckbox, otherIndex) => {
                    if (otherCheckbox !== this) {
                        otherCheckbox.checked = false;
                        answerElements[otherIndex].classList.remove('selected');
                    }
                });
                // დავამატოთ selected კლასი
                answerElements[index].classList.add('selected');
            } else {
                // თუ გავუქმეთ მონიშვნა
                answerElements[index].classList.remove('selected');
            }
        });
        
        // მხოლოდ answer-left ელემენტზე დაკლიკებისას
        const answerLeft = answerElements[index].querySelector('.answer-left');
        if (answerLeft) {
            answerLeft.addEventListener('click', function(e) {
                // თუ checkbox-ზე არ დავაკლიკეთ პირდაპირ
                if (e.target !== checkbox) {
                    checkbox.checked = !checkbox.checked;
                    checkbox.dispatchEvent(new Event('change'));
                }
            });
        }
    });
}

// ვიდეოთვალის ინიციალიზაცია
async function initializeCamera() {
    const video = document.getElementById('camera-video');
    
    if (!video) {
        console.error('Video element not found');
        return;
    }
    
    try {
        // ვიძებთ ყველა ხელმისაწვდომ კამერას
        const devices = await navigator.mediaDevices.enumerateDevices();
        const videoDevices = devices.filter(device => device.kind === 'videoinput');
        
        console.log('Available cameras:', videoDevices);
        
        // ვცდილობთ ვიპოვოთ ვებკამერა (არა ირიუნი ან ვირტუალური)
        let selectedCamera = null;
        
        // ვფილტრავთ ირიუნის და ვირტუალურ კამერებს
        for (const device of videoDevices) {
            const label = device.label.toLowerCase();
            // თუ label არ შეიცავს ირიუნის ან ვირტუალური კამერის მითითებას
            if (!label.includes('iriun') && 
                !label.includes('virtual') && 
                !label.includes('obs') && 
                !label.includes('snap')) {
                selectedCamera = device;
                console.log('Selected camera:', device.label);
                break;
            }
        }
        
        // თუ არ მოიძებნა, გამოვიყენოთ პირველი ხელმისაწვდომი
        if (!selectedCamera && videoDevices.length > 0) {
            selectedCamera = videoDevices[0];
            console.log('Using first available camera:', selectedCamera.label);
        }
        
        const constraints = {
            video: {
                width: { ideal: 1280 },
                height: { ideal: 720 }
            },
            audio: false
        };
        
        // თუ მოიძებნა კონკრეტული კამერა, დავამატოთ deviceId
        if (selectedCamera) {
            constraints.video.deviceId = { exact: selectedCamera.deviceId };
        }
        
        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        
        video.srcObject = stream;
        console.log('Camera initialized successfully');
    } catch (error) {
        console.error('Error accessing camera:', error);
        // თუ კამერა მიუწვდომელია, ვაჩვენოთ შეტყობინება
        const cameraArea = document.querySelector('.camera-area');
        if (cameraArea) {
            cameraArea.style.display = 'flex';
            cameraArea.style.justifyContent = 'center';
            cameraArea.style.alignItems = 'center';
            cameraArea.style.color = 'white';
            cameraArea.innerHTML = '<p>ვიდეოთვალი მიუწვდომელია</p>';
        }
    }
}

