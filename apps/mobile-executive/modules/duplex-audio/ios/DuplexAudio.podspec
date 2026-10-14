Pod::Spec.new do |s|
  s.name           = 'DuplexAudio'
  s.version        = '1.0.0'
  s.summary        = 'Thu micro và phát tiếng trợ lý trong một AVAudioEngine có khử tiếng vọng'
  s.description    = 'Mô-đun Expo nội bộ của app MIHATO Điều hành. Một engine vừa thu vừa phát để voice processing của iOS trừ tiếng loa khỏi micro.'
  s.author         = 'MIHATO'
  s.homepage       = 'https://docs.expo.dev/modules/'
  s.license        = { :type => 'UNLICENSED' }
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }

  s.source_files = "**/*.{h,m,mm,swift}"
end
